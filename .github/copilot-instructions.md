# Copilot instructions for devfest2026

## Project snapshot (what’s actually active)
- FastAPI backend in api/src is the active service; web/ and worker/ are mostly empty scaffolding.
- Core flow: upload audio → create Job row in Postgres → Celery chain → status polling.
- Blueprint validation + preview synthesis are delegated to the MCP music-tools server via `MCPDirector`.
- Object storage is DigitalOcean Spaces (S3-compatible) using presigned URLs.

## Architecture & data flow (read these files first)
- Entry point: api/src/main.py (registers routes + calls `init_db()`).
- Routes: api/src/routes/generate.py (POST /v1/create-moment), api/src/routes/status.py (GET /v1/status/{job_id}).
- Celery pipeline: api/src/services/queue.py
	- generate_blueprint → mark_rendering → chord(group(render_vocals, render_instrumental), mix_and_master).
	- mix_and_master calls MCP `synthesize_preview`, uploads to Spaces, then marks COMPLETED.
- Models + schema: api/src/models/schemas.py (Job, JobStatus, Blueprint, load_blueprint_schema).
- MCP client: api/src/services/blueprint.py (HTTP JSON-RPC, session-aware unless MCP_HTTP_STATELESS).
- Storage: api/src/services/storage.py (boto3 client, upload_to_spaces returns presigned GET URL).
- API reference: docs/api.md.

## Critical workflows (local)
- Install deps from api/requirements.txt and run from api/ to avoid `ModuleNotFoundError: src`.
- API server: uvicorn src.main:app --reload
- Celery worker: celery -A src.services.queue.celery_app worker -l info
- MCP server (Person D): mcp/music-tools (npm run dev or npm run dev:http).

## Configuration & env conventions
- Config: api/src/config.py reads api/.env via pydantic settings.
- Required env: DATABASE_URL, CELERY_BROKER_URL, CELERY_RESULT_BACKEND, DO_SPACES_*.
- MCP URL comes from MCP_BASE_URL (default http://localhost:8080/mcp); auth via MCP_AUTH_TOKEN (Bearer).
- ELEVENLABS_DEFAULT_VOICE_ID is required for the placeholder blueprint + synthesis.
- rediss:// URLs are auto-patched with ssl_cert_reqs=CERT_NONE.

## Project-specific patterns to preserve
- Job lifecycle states are strict enum values: PENDING → ANALYZING → RENDERING → MIXING → COMPLETED.
- The default blueprint is schema-valid and stored in Job.blueprint_json; update it via load_blueprint_schema defaults.
- render_vocals/render_instrumental are stubs returning s3:// paths; mix_and_master returns a placeholder ffmpeg command but the final URL comes from MCP synthesis + Spaces upload.

## Integration points
- MCP server: see mcp/music-tools/README.md for HTTP/stdio modes and auth header.
- DigitalOcean Spaces endpoint must match the region in DO_SPACES_REGION/DO_SPACES_ENDPOINT.
