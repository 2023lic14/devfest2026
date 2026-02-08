from __future__ import annotations

"""Centralized configuration for the API service.

Values are loaded from environment variables and an optional .env file at
the API root to support local development.
"""

from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).resolve().parents[1]


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

	temp_dir: str = "/tmp"


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
