# Main Character Moment (devfest2026)

FastAPI backend that orchestrates the “Main Character Moment” pipeline: upload → blueprint validation → render stubs → synthesize preview → status polling.

## What this repo contains

- api/ — FastAPI service + Celery orchestration (active).
- mcp/music-tools — MCP server used for blueprint validation + preview synthesis.
- web/ and worker/ — scaffolding only (no active logic yet).

## Architecture overview

1. POST /v1/create-moment uploads audio and creates a Job.
2. Celery chain:
	- generate_blueprint → builds a default schema-valid blueprint + validates with MCP.
	- mark_rendering → flips Job to RENDERING.
	- render_vocals + render_instrumental run in a Celery group (stubs).
	- mix_and_master → uses MCP synthesize_preview, uploads to Spaces, marks COMPLETED.
3. GET /v1/status/{job_id} returns status and blueprint_json.

## Required environment variables

Create or update api/.env:

- DATABASE_URL
- CELERY_BROKER_URL
- CELERY_RESULT_BACKEND
- DO_SPACES_KEY
- DO_SPACES_SECRET
- DO_SPACES_REGION
- DO_SPACES_BUCKET
- DO_SPACES_ENDPOINT
- MCP_BASE_URL
- MCP_AUTH_TOKEN (if your MCP server requires auth)
- ELEVENLABS_DEFAULT_VOICE_ID

Example:

```
DATABASE_URL=postgresql+psycopg2://USER:PASSWORD@HOST:PORT/DBNAME?sslmode=require
CELERY_BROKER_URL=rediss://USER:PASSWORD@HOST:PORT
CELERY_RESULT_BACKEND=rediss://USER:PASSWORD@HOST:PORT

DO_SPACES_KEY=...
DO_SPACES_SECRET=...
DO_SPACES_REGION=nyc3
DO_SPACES_BUCKET=devfest2026
DO_SPACES_ENDPOINT=https://nyc3.digitaloceanspaces.com

MCP_BASE_URL=https://your-mcp-server/mcp
MCP_AUTH_TOKEN=
ELEVENLABS_DEFAULT_VOICE_ID=21m00T1W
```

## Local development

From the api directory:

```
pip install -r requirements.txt
uvicorn src.main:app --reload
```

Run the Celery worker:

```
celery -A src.services.queue.celery_app worker -l info
```

Run the MCP server:

```
cd mcp/music-tools
npm run dev:http
```

## Notes

- Celery rediss:// URLs are auto-patched with ssl_cert_reqs=CERT_NONE.
- The mix_and_master task keeps a placeholder FFmpeg command, but the final URL comes from MCP synthesis + Spaces upload.

See docs/api.md for full API reference.
