from __future__ import annotations

import json
import os
import re
import tempfile
from typing import Any, Dict

import httpx
from openai import OpenAI

from src.config import settings


_KEY_RE = re.compile(r"^[A-G](#|b)?m?$")
_TIME_SIG_RE = re.compile(r"^[1-9][0-9]?/[1-9][0-9]?$")


def _clamp_int(value: Any, min_value: int, max_value: int, fallback: int) -> int:
	try:
		n = int(round(float(value)))
	except Exception:
		return fallback
	return max(min_value, min(max_value, n))


def _clamp_float(value: Any, min_value: float, max_value: float) -> float | None:
	try:
		n = float(value)
	except Exception:
		return None
	if n != n:  # NaN
		return None
	return max(min_value, min(max_value, n))


def _is_plain_object(value: Any) -> bool:
	return isinstance(value, dict)


def _download_to_temp(url: str, suffix: str) -> str:
	with tempfile.NamedTemporaryFile(prefix="moment_", suffix=suffix, delete=False) as tmp:
		tmp_path = tmp.name
	with httpx.stream("GET", url, timeout=60.0) as response:
		response.raise_for_status()
		with open(tmp_path, "wb") as f:
			for chunk in response.iter_bytes():
				f.write(chunk)
	return tmp_path


def transcribe_audio_from_url(url: str) -> str:
	if not settings.openai_api_key:
		raise RuntimeError("Missing OPENAI_API_KEY (required for server-side transcription).")

	suffix = os.path.splitext(url.split("?", 1)[0])[1] or ".bin"
	path = _download_to_temp(url, suffix=suffix)
	try:
		client = OpenAI(api_key=settings.openai_api_key, timeout=settings.openai_timeout_seconds)
		with open(path, "rb") as f:
			transcript = client.audio.transcriptions.create(
				file=f,
				model=settings.openai_transcribe_model,
			)
		text = getattr(transcript, "text", "") or ""
		return str(text).strip()
	finally:
		try:
			os.unlink(path)
		except OSError:
			pass


def _prompt_for_blueprint(transcript: str, job_id: str) -> str:
	voice_id = settings.default_voice_id or "21m00T1W"
	model_id = "eleven_multilingual_v2"

	return "\n".join(
		[
			"Generate a Song Blueprint JSON that conforms to the blueprint schema used by this project.",
			"",
			"Hard requirements:",
			"- Output MUST be ONLY valid JSON (no markdown).",
			"- Top-level keys MUST be ONLY: id, style, tempo_bpm, key, time_signature, sections, lyrics, voice, metadata",
			"- sections items MUST ONLY contain: name, bars, energy, prompt",
			"- voice MUST contain voice_id. Other voice fields are optional.",
			"- Do not include null for numeric fields. Omit optional numeric fields if unknown.",
			"",
			"Intent extraction:",
			"- Infer musical intent from the transcript and include in metadata:",
			"  - mood: one short phrase",
			"  - energy: low|medium|high",
			"  - vibe: short phrase",
			"",
			"Safety:",
			"- Use a safe, original style description. Do not mention living artists.",
			"",
			f'Return ONLY JSON. Use id "{job_id}". Use voice.voice_id "{voice_id}". Use voice.model_id "{model_id}".',
			"",
			f'Transcript: """{transcript}"""',
		]
	)


def generate_blueprint_from_transcript(transcript: str, job_id: str) -> Dict[str, Any]:
	if not settings.openai_api_key:
		raise RuntimeError("Missing OPENAI_API_KEY (required for server-side blueprint generation).")

	client = OpenAI(api_key=settings.openai_api_key, timeout=settings.openai_timeout_seconds)
	prompt = _prompt_for_blueprint(transcript, job_id)
	resp = client.chat.completions.create(
		model=settings.openai_model,
		messages=[{"role": "user", "content": prompt}],
		response_format={"type": "json_object"},
		temperature=0.4,
	)
	content = resp.choices[0].message.content if resp.choices else "{}"
	raw = json.loads(content or "{}")
	return sanitize_blueprint(raw, job_id=job_id, transcript=transcript)


def sanitize_blueprint(raw: Any, *, job_id: str, transcript: str | None = None) -> Dict[str, Any]:
	src: Dict[str, Any] = raw if _is_plain_object(raw) else {}

	style = str(src.get("style") or "original pop").strip()[:120] or "original pop"
	tempo_bpm = _clamp_int(src.get("tempo_bpm"), 40, 220, 110)
	key_raw = str(src.get("key") or "C").strip()
	key = key_raw if _KEY_RE.match(key_raw) else "C"
	time_sig_raw = str(src.get("time_signature") or "4/4").strip()
	time_signature = time_sig_raw if _TIME_SIG_RE.match(time_sig_raw) else "4/4"

	sections_raw = src.get("sections") if isinstance(src.get("sections"), list) else []
	sections = []
	for idx, item in enumerate(sections_raw or [{}]):
		sec = item if _is_plain_object(item) else {}
		name = str(sec.get("name") or f"section {idx + 1}").strip() or f"section {idx + 1}"
		bars = _clamp_int(sec.get("bars"), 1, 256, 8)
		energy = _clamp_float(sec.get("energy"), 0.0, 1.0)
		prompt = str(sec.get("prompt")).strip() if isinstance(sec.get("prompt"), str) else None
		section: Dict[str, Any] = {"name": name, "bars": bars}
		if isinstance(energy, float):
			section["energy"] = energy
		if prompt:
			section["prompt"] = prompt
		sections.append(section)

	lyrics = str(src.get("lyrics") or "").strip()
	if not lyrics:
		lyrics = "Placeholder lyrics."

	voice_src = src.get("voice") if _is_plain_object(src.get("voice")) else {}
	voice_id = str(voice_src.get("voice_id") or settings.default_voice_id or "").strip()
	if not voice_id:
		raise RuntimeError("Missing ELEVENLABS_DEFAULT_VOICE_ID (needed for blueprint.voice.voice_id).")

	voice: Dict[str, Any] = {"voice_id": voice_id}
	model_id = voice_src.get("model_id")
	if isinstance(model_id, str) and model_id.strip():
		voice["model_id"] = model_id.strip()

	for key_name in ("stability", "similarity_boost", "style_exaggeration"):
		value = _clamp_float(voice_src.get(key_name), 0.0, 1.0)
		if isinstance(value, float):
			voice[key_name] = value

	speaker_boost = voice_src.get("speaker_boost")
	if isinstance(speaker_boost, bool):
		voice["speaker_boost"] = speaker_boost

	metadata_src = src.get("metadata") if _is_plain_object(src.get("metadata")) else {}
	metadata: Dict[str, Any] = dict(metadata_src)
	if transcript:
		metadata["transcript"] = transcript

	return {
		"id": job_id,
		"style": style,
		"tempo_bpm": tempo_bpm,
		"key": key,
		"time_signature": time_signature,
		"sections": sections,
		"lyrics": lyrics,
		"voice": voice,
		"metadata": metadata,
	}

