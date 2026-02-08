# music-tools MCP server

Minimal MCP server for Person D scope.

Tools:
- `validate_blueprint`: validates against `docs/blueprint_schema.json`
- `synthesize_preview`: calls ElevenLabs text-to-speech and saves preview audio
- `create_song`: calls ElevenLabs Music (`POST /v1/music`) to generate an instrumental+vocal song from blueprint/style/lyrics
- `create_moment`: calls the FastAPI `/v1/create-moment` endpoint (multipart upload) and polls `/v1/status/{job_id}` until completion

Transports:
- `stdio` (default, local MCP clients)
- `http` (Streamable HTTP endpoint for ElevenLabs Custom MCP URL)
- Optional deprecated SSE compatibility mode (`/sse` + `/messages`)

## Setup

```bash
cd mcp/music-tools
npm install
```

Create or update `mcp/music-tools/.env` with required values:
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_DEFAULT_VOICE_ID` (recommended)

Note: Deployments that only include the `mcp/music-tools` folder should rely on the bundled schema at
`mcp/music-tools/docs/blueprint_schema.json`. If you customize the schema location, set
`BLUEPRINT_SCHEMA_PATH` to an absolute path.

## Stdio mode (local)

```bash
npm run dev
```

## HTTP mode (for ElevenLabs Custom MCP URL)

```bash
npm run dev:http
```

or production:

```bash
npm run build
npm run start:http
```

Defaults:
- URL: `http://0.0.0.0:8080/mcp`
- Health: `http://0.0.0.0:8080/healthz`

## Auth

If `MCP_AUTH_TOKEN` is set, requests must include:

```http
Authorization: Bearer <MCP_AUTH_TOKEN>
```

## ElevenLabs Custom MCP setup

1. Run in HTTP mode.
2. Expose the server publicly (cloud deploy or tunnel).
3. Copy URL: `https://<public-host>/mcp`.
4. In ElevenLabs Custom MCP server config:
- URL: `https://<public-host>/mcp`
- Header (if auth enabled): `Authorization: Bearer <MCP_AUTH_TOKEN>`
5. Test tools:
- `validate_blueprint`
- `synthesize_preview`
- `create_song`

## Public URL quick option (development)

```bash
ngrok http 8080
```

Then use `https://<ngrok-host>/mcp` in ElevenLabs.

## Key env vars

- `MCP_TRANSPORT=stdio|http`
- `MCP_HTTP_HOST` default `0.0.0.0`
- `MCP_HTTP_PORT` default `8080`
- `MCP_HTTP_PATH` default `/mcp`
- `MCP_AUTH_TOKEN` optional bearer token
- `MCP_ENABLE_JSON_RESPONSE=true|false` (default `false`)
- `MCP_HTTP_STATELESS=true|false` (default `false`, keep `false` recommended)
- `MCP_ENABLE_LEGACY_SSE=true|false` (default `false`)
- `MCP_CREATE_SONG_TIMEOUT_MS` default `300000` (gpt-agent tool timeout for long music generation)
- `MOMENT_API_BASE_URL` default `http://127.0.0.1:8000` (used by `create_moment`)
- `DO_SPACES_KEY`, `DO_SPACES_SECRET`, `DO_SPACES_REGION`, `DO_SPACES_ENDPOINT`, `DO_SPACES_BUCKET` (upload MCP outputs to Spaces)
- `DO_SPACES_PUBLIC_BASE_URL` optional public base URL for outputs (defaults to `${DO_SPACES_ENDPOINT}/${DO_SPACES_BUCKET}`)
- `DO_SPACES_PREFIX` optional key prefix for uploads (default `mcp/outputs`)

## GPT bridge

The `npm run gpt-agent` script turns an OpenAI chat model into an MCP client for your tunneled server. It uses OpenAI function calling to route GPT tool requests through the MCP transport and back to the model.

Requirements:

* `OPENAI_API_KEY` – API key for the OpenAI model you plan to use.
* `MCP_TUNNEL_URL` – the public URL for your tunnel (for example `https://sao-head-moore-albums.trycloudflare.com/mcp`).
* Optional: `OPENAI_MODEL` (defaults to `gpt-4o-mini`) and any `gpt-agent` arguments.

Usage (preview):

```bash
OPENAI_API_KEY=sk_... MCP_TUNNEL_URL=https://.../mcp npm run gpt-agent -- "Validate my blueprint and synthesize a preview."
```

The script prints the MCP tool name and arguments chosen by GPT along with the tool outputs. Use it to iterate on prompts and verify `validate_blueprint` and `synthesize_preview` before wiring more advanced agents.

Usage (full song via ElevenLabs Music):

```bash
OPENAI_API_KEY=sk_... MCP_TUNNEL_URL=https://.../mcp npm run gpt-agent -- "Create a song with vocals and instrumental from this blueprint."
```

### Blueprint configuration

By default the bridge uses a fully fleshed-out blueprint (`demo-blueprint`, catchy pop-folk with poetic storytelling influences, time signature 4/4, multiple sections, and voice metadata) so GPT always has valid data. To inject your own blueprint, point `MCP_BLUEPRINT_JSON` at a JSON string or use the CLI to feed in a blueprint payload:

```bash
OPENAI_API_KEY=sk_... \
MCP_TUNNEL_URL=https://.../mcp \
MCP_BLUEPRINT_JSON='{"id":"custom","style":"space","tempo_bpm":90,"key":"F","sections":[{"name":"intro","bars":4}],"lyrics":"Custom lyrics here.","voice":{"voice_id":"21m00T1W"}}' \
npm run gpt-agent -- "Validate this blueprint and synthesize a preview."
```

The default blueprint is used whenever `MCP_BLUEPRINT_JSON` is missing, so simple prompts still work.

### Audio preview storage

When GPT triggers `synthesize_preview`, the MCP server writes an MP3 file under `ELEVENLABS_OUTPUT_DIR` (default `tmp/audio-previews`). The GPT bridge now copies that file to a persistent location under `tmp/audio-previews/<timestamp>-preview.mp3` and logs the path. Check that path to listen to the generated audio or upload it to shared storage for others. Keep the storage directory mounted if you want team access to the previews.

## Audio -> Blueprint -> API

If you want to turn an audio file into a schema-valid blueprint and submit it to the backend pipeline:

```bash
cd mcp/music-tools
npm run audio:moment -- ../../audio/devfest-test-1.m4a --api http://127.0.0.1:8000 --kind song
```
