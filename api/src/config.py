from __future__ import annotations

"""Centralized configuration for the API service.

Values are loaded from environment variables and an optional .env file at
the API root to support local development.
"""

from pathlib import Path
import os
import re
import socket
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).resolve().parents[1]


def _default_celery_queue() -> str:
	"""Default to a per-machine queue to avoid consuming jobs from shared brokers."""
	user = os.environ.get("USER") or os.environ.get("USERNAME") or "local"
	host = socket.gethostname().split(".", 1)[0] or "host"
	queue = f"devfest2026.{user}.{host}"
	return re.sub(r"[^a-zA-Z0-9_.-]+", "_", queue)[:128]


class Settings(BaseSettings):
	"""Runtime configuration loaded from environment variables."""
	model_config = SettingsConfigDict(
		env_prefix="",
		case_sensitive=False,
		env_file=str(BASE_DIR / ".env"),
		extra="ignore",
	)

	database_url: str = "postgresql+psycopg2://postgres:postgres@localhost:5432/devfest"
	celery_broker_url: str = "redis://localhost:6379/0"
	celery_result_backend: str = "redis://localhost:6379/1"
	# When using a shared broker (hosted Redis/Valkey), set this to a unique name and run your
	# worker with `-Q <queue>` so other workers can't accidentally consume your jobs.
	celery_queue: str = Field(default_factory=_default_celery_queue, alias="CELERY_QUEUE")

	do_spaces_key: str = ""
	do_spaces_secret: str = ""
	do_spaces_region: str = "nyc3"
	do_spaces_endpoint: str = "https://nyc3.digitaloceanspaces.com"
	do_spaces_bucket: str = ""
	do_spaces_url_expiry_seconds: int = 3600

	mcp_server_url: str = Field(default="http://localhost:8080/mcp", alias="MCP_BASE_URL")
	mcp_timeout_seconds: float = 30.0
	mcp_auth_token: str | None = Field(default=None, alias="MCP_AUTH_TOKEN")
	mcp_http_stateless: bool = Field(default=False, alias="MCP_HTTP_STATELESS")
	default_voice_id: str = Field(default="", alias="ELEVENLABS_DEFAULT_VOICE_ID")
	# Controls whether the backend asks MCP to synthesize a TTS preview or a full song.
	# Values: "preview" (default) or "song".
	mcp_output_kind: str = Field(default="song", alias="MCP_OUTPUT_KIND")

	# Optional knobs for MCP create_song (ElevenLabs Music) when output_kind == "song".
	mcp_song_timeout_seconds: float = Field(default=600.0, alias="MCP_SONG_TIMEOUT_SECONDS")
	mcp_song_model_id: str | None = Field(default=None, alias="MCP_SONG_MODEL_ID")
	mcp_song_prompt: str | None = Field(default=None, alias="MCP_SONG_PROMPT")
	mcp_song_length_ms: int = Field(default=180000, alias="MCP_SONG_LENGTH_MS")
	mcp_song_force_instrumental: bool = Field(default=False, alias="MCP_SONG_FORCE_INSTRUMENTAL")
	mcp_song_output_format: str = Field(default="mp3_44100_128", alias="MCP_SONG_OUTPUT_FORMAT")

	temp_dir: str = "/tmp"

	# Server-side OpenAI usage (blueprint generation from uploaded audio when blueprint_json is omitted).
	openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")
	openai_model: str = Field(default="gpt-4o-mini", alias="OPENAI_MODEL")
	openai_transcribe_model: str = Field(default="gpt-4o-transcribe", alias="OPENAI_TRANSCRIBE_MODEL")
	openai_timeout_seconds: float = Field(default=120.0, alias="OPENAI_TIMEOUT_SECONDS")

	# Comma-separated list of allowed CORS origins for local dev.
	# Example: "http://localhost:3000,http://127.0.0.1:3000"
	cors_allow_origins: str = Field(
		default="http://localhost:3000,http://127.0.0.1:3000",
		alias="CORS_ALLOW_ORIGINS",
	)


settings = Settings()


def _ensure_rediss_ssl_params(url: str) -> str:
	if not url.startswith("rediss://"):
		return url

	parts = urlsplit(url)
	query = dict(parse_qsl(parts.query, keep_blank_values=True))
	if "ssl_cert_reqs" not in query:
		query["ssl_cert_reqs"] = "CERT_NONE"
	return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


settings.celery_broker_url = _ensure_rediss_ssl_params(settings.celery_broker_url)
settings.celery_result_backend = _ensure_rediss_ssl_params(settings.celery_result_backend)
