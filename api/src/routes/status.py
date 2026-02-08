from __future__ import annotations

"""Routes for polling job status."""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
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
def proxy_audio(request: Request, url: str = Query(..., min_length=1)) -> Response:
	"""Proxy audio files to avoid browser CORS issues.

	Uses streaming so large stem files (wav) can load without buffering the entire file in memory.
	Also forwards Range requests to support efficient waveform loading.
	"""
	if not _is_allowed_proxy_url(url):
		raise HTTPException(status_code=400, detail="URL is not allowed for proxying.")

	upstream_headers: dict[str, str] = {}
	range_header = request.headers.get("range")
	if range_header:
		upstream_headers["range"] = range_header

	try:
		# Enter the stream context manually so we can return an iterator without buffering.
		stream = httpx.stream("GET", url, headers=upstream_headers, timeout=httpx.Timeout(60.0, read=None))
		response = stream.__enter__()
		response.raise_for_status()
	except httpx.HTTPError as exc:
		try:
			stream.__exit__(type(exc), exc, exc.__traceback__)  # type: ignore[name-defined]
		except Exception:
			pass
		raise HTTPException(status_code=502, detail=f"Proxy request failed: {exc}") from exc

	content_type = response.headers.get("content-type", "application/octet-stream")
	headers: dict[str, str] = {}
	for key in ("content-length", "accept-ranges", "content-range"):
		if key in response.headers:
			headers[key] = response.headers[key]

	def _iter_bytes():
		try:
			for chunk in response.iter_bytes(chunk_size=1024 * 256):
				yield chunk
		finally:
			stream.__exit__(None, None, None)

	return StreamingResponse(_iter_bytes(), media_type=content_type, headers=headers)
