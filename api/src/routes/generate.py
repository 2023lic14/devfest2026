from __future__ import annotations

"""Routes for creating a Main Character Moment job."""

import os
import uuid

from fastapi import APIRouter, Depends, File, UploadFile
from sqlalchemy.orm import Session

from src.config import settings
from src.models.schemas import CreateMomentResponse, Job, JobStatus
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
async def create_moment(file: UploadFile = File(...), db: Session = Depends(get_db)) -> CreateMomentResponse:
	"""Accept an upload, persist a Job, and trigger the Celery pipeline."""
	job_id = str(uuid.uuid4())

	temp_path = os.path.join(settings.temp_dir, f"{job_id}_{file.filename}")
	with open(temp_path, "wb") as buffer:
		buffer.write(await file.read())

	object_name = f"moments/{job_id}/original/{file.filename}"
	original_audio_url = upload_to_spaces(temp_path, object_name)

	job = Job(
		id=job_id,
		status=JobStatus.pending,
		original_audio_url=original_audio_url,
		blueprint_json=None,
		final_audio_url=None,
	)
	db.add(job)
	db.commit()

	chain(
		generate_blueprint.s(job_id),
		mark_rendering.s(),
		chord(
			group(render_vocals.s(), render_instrumental.s()),
			mix_and_master.s(),
		),
		separate_stems.s(),
	).apply_async()

	return CreateMomentResponse(job_id=job_id)
