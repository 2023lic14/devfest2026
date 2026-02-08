from __future__ import annotations

"""Celery task orchestration for the audio pipeline.

This module defines the chainable tasks used by the API to process a
"Main Character Moment" request.
"""

from typing import Any, Dict
import os
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

import httpx

from celery import Celery
from kombu import Queue
from sqlalchemy.orm.attributes import flag_modified

from src.config import settings
from src.models.schemas import Job, JobStatus, load_blueprint_schema
from src.services.ai_blueprint import generate_blueprint_from_transcript, transcribe_audio_from_url
from src.services.blueprint import MCPDirector
from src.services.db import session_scope
from src.services.storage import upload_to_spaces

celery_app = Celery(
	"devfest",
	broker=settings.celery_broker_url,
	backend=settings.celery_result_backend,
)

# Route all tasks to a dedicated queue by default (important when using a shared broker).
celery_app.conf.task_default_queue = settings.celery_queue
celery_app.conf.task_default_routing_key = settings.celery_queue
celery_app.conf.task_queues = (Queue(settings.celery_queue, routing_key=settings.celery_queue),)


def _update_job(job_id: str, **fields: Any) -> None:
	"""Persist job state changes from background tasks."""
	with session_scope() as session:
		job = session.get(Job, job_id)
		if not job:
			return
		for key, value in fields.items():
			setattr(job, key, value)


def _update_job_metadata(job_id: str, **metadata_updates: Any) -> None:
	"""Merge metadata into the blueprint JSON payload."""
	with session_scope() as session:
		job = session.get(Job, job_id)
		if not job or not job.blueprint_json:
			return
		blueprint = job.blueprint_json
		metadata = blueprint.setdefault("metadata", {})
		metadata.update(metadata_updates)
		job.blueprint_json = dict(blueprint)
		session.add(job)
		flag_modified(job, "blueprint_json")


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
	"""Generate (or reuse) a blueprint and validate it with MCP."""
	_update_job(job_id, status=JobStatus.analyzing)

	with session_scope() as session:
		job = session.get(Job, job_id)
		if not job:
			return {"job_id": job_id, "blueprint": {}}

		if job.blueprint_json:
			blueprint = job.blueprint_json
		else:
			# Server-side "record -> upload -> blueprint" path for the frontend.
			transcript = transcribe_audio_from_url(job.original_audio_url)
			blueprint = generate_blueprint_from_transcript(transcript, job_id=job_id)

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

	metadata = blueprint.get("metadata", {}) if isinstance(blueprint, dict) else {}
	raw_output_kind = metadata.get("output_kind") or settings.mcp_output_kind or "preview"
	output_kind = str(raw_output_kind).strip().lower()
	if output_kind not in {"preview", "song"}:
		output_kind = "preview"

	_update_job_metadata(job_id, output_kind=output_kind)

	voice = blueprint.get("voice", {}) if isinstance(blueprint, dict) else {}
	voice_id = voice.get("voice_id") or settings.default_voice_id
	lyrics = blueprint.get("lyrics") if isinstance(blueprint, dict) else None
	model_id = voice.get("model_id") if isinstance(voice, dict) else None

	# create_song can take minutes; use a longer timeout for that call.
	timeout = settings.mcp_song_timeout_seconds if output_kind == "song" else settings.mcp_timeout_seconds
	director = MCPDirector(timeout_seconds=timeout)

	if output_kind == "song":
		_update_job_metadata(job_id, mcp_tool_used="create_song")
		synthesis = director.create_song(
			blueprint=blueprint,
			prompt=settings.mcp_song_prompt,
			model_id=settings.mcp_song_model_id,
			music_length_ms=settings.mcp_song_length_ms,
			force_instrumental=settings.mcp_song_force_instrumental,
			output_format=settings.mcp_song_output_format,
		)
	else:
		_update_job_metadata(job_id, mcp_tool_used="synthesize_preview")
		if not voice_id:
			raise RuntimeError("Missing voice_id for ElevenLabs synthesis. Set ELEVENLABS_DEFAULT_VOICE_ID.")
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


@celery_app.task(name="separate_stems")
def separate_stems(payload: Dict[str, Any]) -> Dict[str, Any]:
	"""Split the final mix into stems for manual editing."""
	job_id = payload.get("job_id")
	final_audio_url = payload.get("final_audio_url")
	if not job_id or not final_audio_url:
		return payload

	parsed = urlsplit(final_audio_url)
	_, ext = os.path.splitext(parsed.path)
	input_ext = ext or ".mp3"

	with tempfile.TemporaryDirectory(prefix=f"stems_{job_id}_") as temp_dir:
		input_path = os.path.join(temp_dir, f"final{input_ext}")
		with httpx.stream("GET", final_audio_url, timeout=60.0) as response:
			response.raise_for_status()
			with open(input_path, "wb") as audio_file:
				for chunk in response.iter_bytes():
					audio_file.write(chunk)

		wav_path = os.path.join(temp_dir, "final.wav")
		try:
			subprocess.run(
				["ffmpeg", "-y", "-i", input_path, "-ac", "2", "-ar", "44100", wav_path],
				check=True,
				stdout=subprocess.DEVNULL,
				stderr=subprocess.DEVNULL,
			)
			demucs_input = wav_path
		except (subprocess.CalledProcessError, FileNotFoundError) as exc:
			_update_job_metadata(job_id, stems_error=f"ffmpeg failed: {exc}")
			return payload

		output_dir = os.path.join(temp_dir, "demucs")
		command = [
			sys.executable,
			"-m",
			"demucs",
			"-n",
			"htdemucs",
			"--out",
			output_dir,
			demucs_input,
		]
		try:
			subprocess.run(command, check=True)
		except (subprocess.CalledProcessError, FileNotFoundError) as exc:
			_update_job_metadata(job_id, stems_error=str(exc))
			return payload

		base_name = os.path.splitext(os.path.basename(demucs_input))[0]
		stem_dir = os.path.join(output_dir, "htdemucs", base_name)
		if not os.path.isdir(stem_dir):
			_update_job_metadata(job_id, stems_error="Stem output folder not found.")
			return payload

		stems: Dict[str, str] = {}
		for stem_name in ("vocals", "drums", "bass", "other"):
			stem_path = os.path.join(stem_dir, f"{stem_name}.wav")
			if not os.path.exists(stem_path):
				continue
			object_name = f"renders/{job_id}/stems/{stem_name}.wav"
			stems[stem_name] = upload_to_spaces(stem_path, object_name)

		if stems:
			_update_job_metadata(job_id, stems=stems)
		else:
			_update_job_metadata(job_id, stems_error="No stems produced.")

	return payload
