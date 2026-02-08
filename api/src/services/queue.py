from __future__ import annotations

"""Celery task orchestration for the audio pipeline.

This module defines the chainable tasks used by the API to process a
"Main Character Moment" request.
"""

from typing import Any, Dict
import os

from celery import Celery

from src.config import settings
from src.models.schemas import Job, JobStatus, load_blueprint_schema
from src.services.blueprint import MCPDirector
from src.services.db import session_scope
from src.services.storage import upload_to_spaces

celery_app = Celery(
	"devfest",
	broker=settings.celery_broker_url,
	backend=settings.celery_result_backend,
)


def _update_job(job_id: str, **fields: Any) -> None:
	"""Persist job state changes from background tasks."""
	with session_scope() as session:
		job = session.get(Job, job_id)
		if not job:
			return
		for key, value in fields.items():
			setattr(job, key, value)


def _default_blueprint(job_id: str, original_audio_url: str) -> Dict[str, Any]:
	"""Create a minimal, schema-valid blueprint placeholder."""
	if not settings.default_voice_id:
		raise RuntimeError("Missing ELEVENLABS_DEFAULT_VOICE_ID for default blueprint.")

	schema = load_blueprint_schema()
	props = schema.get("properties", {})
	defs = schema.get("$defs", {})
	section_schema = defs.get("section", {}).get("properties", {})
	voice_schema = defs.get("voice", {}).get("properties", {})
	default_time_signature = props.get("time_signature", {}).get("default", "4/4")
	default_energy = section_schema.get("energy", {}).get("default", 0.5)
	default_model_id = voice_schema.get("model_id", {}).get("default", "eleven_multilingual_v2")
	default_speaker_boost = voice_schema.get("speaker_boost", {}).get("default", True)

	return {
		"id": job_id,
		"style": "placeholder",
		"tempo_bpm": 110,
		"key": "C",
		"time_signature": default_time_signature,
		"sections": [
			{
				"name": "verse",
				"bars": 8,
				"energy": default_energy,
			}
		],
		"lyrics": "Placeholder lyrics generated from uploaded audio.",
		"voice": {
			"voice_id": settings.default_voice_id,
			"model_id": default_model_id,
			"speaker_boost": default_speaker_boost,
		},
		"metadata": {
			"source": "api-placeholder",
			"original_audio_url": original_audio_url,
		},
	}


@celery_app.task(name="generate_blueprint")
def generate_blueprint(job_id: str) -> Dict[str, Any]:
	"""Build a placeholder blueprint and validate it with MCP."""
	_update_job(job_id, status=JobStatus.analyzing)

	with session_scope() as session:
		job = session.get(Job, job_id)
		if not job:
			return {"job_id": job_id, "blueprint": {}}

		blueprint = _default_blueprint(job_id, job.original_audio_url)
		director = MCPDirector()
		validation = director.validate_blueprint(blueprint)
		if isinstance(validation, dict):
			metadata = blueprint.setdefault("metadata", {})
			metadata["validation"] = validation.get("structuredContent", validation)

		job.blueprint_json = blueprint

	return {"job_id": job_id, "blueprint": blueprint, "validation": validation}


@celery_app.task(name="mark_rendering")
def mark_rendering(payload: Dict[str, Any]) -> Dict[str, Any]:
	"""Transition job into the rendering state."""
	job_id = payload["job_id"]
	_update_job(job_id, status=JobStatus.rendering)
	return payload


@celery_app.task(name="render_vocals")
def render_vocals(payload: Dict[str, Any]) -> Dict[str, Any]:
	"""Stub vocal renderer (replace with real generation)."""
	job_id = payload["job_id"]
	return {"type": "vocals", "url": f"s3://renders/{job_id}/vocals.wav", "job_id": job_id}


@celery_app.task(name="render_instrumental")
def render_instrumental(payload: Dict[str, Any]) -> Dict[str, Any]:
	"""Stub instrumental renderer (replace with real generation)."""
	job_id = payload["job_id"]
	return {
		"type": "instrumental",
		"url": f"s3://renders/{job_id}/instrumental.wav",
		"job_id": job_id,
	}


@celery_app.task(name="mix_and_master")
def mix_and_master(assets: list[Dict[str, Any]]) -> Dict[str, Any]:
	"""Mix assets and update final URL using MCP audio output."""
	job_id = ""
	for asset in assets:
		job_id = asset.get("job_id") or job_id
		if job_id:
			break
	if not job_id:
		raise RuntimeError("Missing job_id in asset payloads.")

	_update_job(job_id, status=JobStatus.mixing)

	vocals = next((a for a in assets if a.get("type") == "vocals"), {})
	instrumental = next((a for a in assets if a.get("type") == "instrumental"), {})

	ffmpeg_command = (
		"ffmpeg -i {instrumental} -i {vocals} "
		"-filter_complex '[1:a]sidechaincompress[sc];[0:a][sc]amix' "
		"-c:a libmp3lame output.mp3"
	).format(instrumental=instrumental.get("url", ""), vocals=vocals.get("url", ""))

	with session_scope() as session:
		job = session.get(Job, job_id)
		if not job or not job.blueprint_json:
			raise RuntimeError("Missing blueprint data for MCP synthesis.")
		blueprint = job.blueprint_json

	voice = blueprint.get("voice", {}) if isinstance(blueprint, dict) else {}
	voice_id = voice.get("voice_id") or settings.default_voice_id
	if not voice_id:
		raise RuntimeError("Missing voice_id for ElevenLabs synthesis. Set ELEVENLABS_DEFAULT_VOICE_ID.")
	lyrics = blueprint.get("lyrics") if isinstance(blueprint, dict) else None
	model_id = voice.get("model_id") if isinstance(voice, dict) else None

	director = MCPDirector()
	synthesis = director.synthesize_preview(text=lyrics, voice_id=voice_id, model_id=model_id)
	structured = synthesis.get("structuredContent", {}) if isinstance(synthesis, dict) else {}
	if not structured.get("ok"):
		raise RuntimeError(f"MCP synthesis failed: {structured}")
	output_path = structured.get("output_path")
	if not output_path or not os.path.exists(output_path):
		raise RuntimeError("MCP synthesis output file not found.")

	_, ext = os.path.splitext(output_path)
	final_ext = ext.lstrip(".") or "mp3"
	final_object_name = f"renders/{job_id}/final.{final_ext}"
	final_audio_url = upload_to_spaces(output_path, final_object_name)

	_update_job(job_id, status=JobStatus.completed, final_audio_url=final_audio_url)

	return {"job_id": job_id, "ffmpeg": ffmpeg_command, "final_audio_url": final_audio_url}
