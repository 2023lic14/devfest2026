from __future__ import annotations

"""Routes for polling job status."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from src.models.schemas import Job, StatusResponse
from src.services.db import get_db

router = APIRouter(prefix="/v1", tags=["moments"])


@router.get("/status/{job_id}", response_model=StatusResponse)
def get_status(job_id: str, db: Session = Depends(get_db)) -> StatusResponse:
	"""Return the current job status and any generated blueprint data."""
	job = db.get(Job, job_id)
	if not job:
		raise HTTPException(status_code=404, detail="Job not found")

	return StatusResponse(
		id=job.id,
		status=job.status,
		original_audio_url=job.original_audio_url,
		blueprint_json=job.blueprint_json,
		final_audio_url=job.final_audio_url,
	)
