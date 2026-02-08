from __future__ import annotations

"""Routes for polling job status."""

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session
from urllib.parse import urlsplit

import httpx

from src.models.schemas import Job, StatusResponse
from src.services.db import get_db

router = APIRouter(prefix="/v1", tags=["moments"])


def _is_allowed_proxy_url(raw_url: str) -> bool:
	try:
		parsed = urlsplit(raw_url)
	except ValueError:
		return False
	if parsed.scheme not in {"http", "https"}:
		return False
	host = parsed.hostname or ""
	return host.endswith("digitaloceanspaces.com")


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


@router.get("/proxy-audio")
def proxy_audio(url: str = Query(..., min_length=1)) -> Response:
	"""Proxy audio files to avoid browser CORS issues."""
	if not _is_allowed_proxy_url(url):
		raise HTTPException(status_code=400, detail="URL is not allowed for proxying.")
	try:
		response = httpx.get(url, timeout=60.0)
		response.raise_for_status()
	except httpx.HTTPError as exc:
		raise HTTPException(status_code=502, detail=f"Proxy request failed: {exc}") from exc

	content_type = response.headers.get("content-type", "application/octet-stream")
	return Response(content=response.content, media_type=content_type)
