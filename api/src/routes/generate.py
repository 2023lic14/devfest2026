from __future__ import annotations

"""Routes for creating a Main Character Moment job."""

import os
import uuid
from fastapi import APIRouter, Depends, File, UploadFile, Form, HTTPException
from sqlalchemy.orm import Session

from src.config import settings
from src.models.schemas import Blueprint, CreateMomentResponse, Job, JobStatus
from src.services.db import get_db
from celery import chain, chord, group

from src.services.queue import (
	generate_blueprint,
	mark_rendering,
	mix_and_master,
	render_instrumental,
	render_vocals,
	separate_stems,
)
from src.services.storage import upload_to_spaces

router = APIRouter(prefix="/v1", tags=["moments"])


@router.post("/create-moment", response_model=CreateMomentResponse)
async def create_moment(
	file: UploadFile = File(...),
	blueprint_json: str | None = Form(default=None),
	output_kind: str | None = Form(default=None),
	db: Session = Depends(get_db),
) -> CreateMomentResponse:
	"""Accept an upload, persist a Job, and trigger the Celery pipeline."""
	job_id = str(uuid.uuid4())

	temp_path = os.path.join(settings.temp_dir, f"{job_id}_{file.filename}")
	with open(temp_path, "wb") as buffer:
		buffer.write(await file.read())

	object_name = f"moments/{job_id}/original/{file.filename}"
	original_audio_url = upload_to_spaces(temp_path, object_name)

	normalized_output_kind: str | None = None
	if output_kind is not None:
		normalized_output_kind = output_kind.strip().lower()
		if normalized_output_kind and normalized_output_kind not in {"preview", "song"}:
			raise HTTPException(status_code=400, detail="Invalid output_kind (expected 'preview' or 'song').")

	parsed_blueprint: dict | None = None
	if blueprint_json:
		try:
			# Drop optional fields that default to None so AJV doesn't see `null` for numeric fields.
			# (The MCP schema expects numbers, and `null` fails validation.)
			parsed_blueprint = Blueprint.model_validate_json(blueprint_json).model_dump(exclude_none=True)
		except Exception as exc:
			raise HTTPException(status_code=400, detail=f"Invalid blueprint_json: {exc}") from exc

		# Allow the caller to force output kind without having to mutate the blueprint on their side.
		if normalized_output_kind:
			metadata = parsed_blueprint.setdefault("metadata", {})
			metadata["output_kind"] = normalized_output_kind

	job = Job(
		id=job_id,
		status=JobStatus.pending,
		original_audio_url=original_audio_url,
		blueprint_json=parsed_blueprint,
		final_audio_url=None,
	)
	db.add(job)
	db.commit()

	queue = settings.celery_queue
	chain(
		generate_blueprint.s(job_id).set(queue=queue),
		mark_rendering.s().set(queue=queue),
		chord(
			group(
				render_vocals.s().set(queue=queue),
				render_instrumental.s().set(queue=queue),
			),
			mix_and_master.s().set(queue=queue),
		),
		separate_stems.s().set(queue=queue),
	).apply_async(queue=queue)

	return CreateMomentResponse(job_id=job_id)
