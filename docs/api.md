# Main Character Moment API

Backend service that orchestrates the “Main Character Moment” pipeline: upload → blueprint validation → render stubs → synthesize preview → status polling.

## What this API does

- Accepts a hum/audio upload and stores it in DigitalOcean Spaces.
- Creates a Job record in PostgreSQL and tracks lifecycle status.
- Kicks off a Celery chain for blueprint validation, rendering stubs, and preview synthesis.
- Exposes status polling with the live blueprint JSON so the frontend can show progress.

## Architecture overview

1. POST /v1/create-moment uploads audio and creates a Job.
2. Celery chain:
	 - generate_blueprint → builds a default schema-valid blueprint + validates with MCP.
	 - mark_rendering → flips Job to RENDERING.
	 - render_vocals + render_instrumental run in a Celery group (stubs).
	 - mix_and_master → uses MCP synthesize_preview, uploads to Spaces, marks COMPLETED.
3. GET /v1/status/{job_id} returns status and blueprint_json.

## Services and dependencies

- PostgreSQL (state storage)
- Valkey/Redis (Celery broker + result backend)
- DigitalOcean Spaces (object storage)
- MCP server (Person D) for blueprint validation + preview synthesis

## Required environment variables

Create or update the env file at [api/.env](../api/.env):

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

Install dependencies:

```
pip install -r requirements.txt
```

Run the API server:

```
uvicorn src.main:app --reload
```

Run the Celery worker:

```
celery -A src.services.queue.celery_app worker -l info
```

Run the MCP server (Person D) from the repo root:

```
cd mcp/music-tools
npm run dev:http
```

## API endpoints

### POST /v1/create-moment

Creates a new Job and starts the Celery chain.

- Content-Type: multipart/form-data
- Field: file (audio upload)
- Optional Field: blueprint_json (stringified JSON matching docs/blueprint_schema.json)
- Optional Field: output_kind (preview|song). Stored in blueprint metadata and used by the worker to choose MCP `synthesize_preview` vs `create_song`.

Response:

```
{
	"job_id": "uuid"
}
```

### GET /v1/status/{job_id}

Returns the current Job status and blueprint JSON.

Response:

```
{
	"id": "uuid",
	"status": "ANALYZING",
	"original_audio_url": "https://...",
	"blueprint_json": { "style": "cinematic" },
	"final_audio_url": null
}
```

## Job lifecycle statuses

- PENDING
- ANALYZING
- RENDERING
- MIXING
- COMPLETED

## Configuration and code locations

- Config: [api/src/config.py](../api/src/config.py)
- Database: [api/src/services/db.py](../api/src/services/db.py)
- Models: [api/src/models/schemas.py](../api/src/models/schemas.py)
- Storage: [api/src/services/storage.py](../api/src/services/storage.py)
- MCP client: [api/src/services/blueprint.py](../api/src/services/blueprint.py)
- Celery tasks: [api/src/services/queue.py](../api/src/services/queue.py)
- Routes: [api/src/routes/generate.py](../api/src/routes/generate.py), [api/src/routes/status.py](../api/src/routes/status.py)

## Operational notes

- Celery with rediss:// requires ssl_cert_reqs. The app auto-appends ssl_cert_reqs=CERT_NONE if missing.
- DigitalOcean Spaces uses an S3-compatible endpoint; DO_SPACES_ENDPOINT should match your region.
- The mix_and_master task keeps a placeholder FFmpeg command, but the final URL comes from MCP synthesis + Spaces upload.

## Troubleshooting

- ModuleNotFoundError: No module named 'src'
	- Run from the api directory, or set PYTHONPATH to the api folder.
- Celery rediss ssl error
	- Ensure rediss URL includes ssl_cert_reqs; the app now auto-fixes this.
- Database connection errors
	- Verify DATABASE_URL and that the managed database allows inbound connections.

## Security checklist

- Never commit secrets to git.
- Rotate Spaces keys if exposed.
- Use CERT_REQUIRED and a CA bundle for strict TLS in production.
