# music-tools MCP server

Minimal MCP server for Person D scope.

Tools:
- `validate_blueprint`: validates against `docs/blueprint_schema.json`
- `synthesize_preview`: calls ElevenLabs text-to-speech and saves preview audio

Transports:
- `stdio` (default, local MCP clients)
- `http` (Streamable HTTP endpoint for ElevenLabs Custom MCP URL)
- Optional deprecated SSE compatibility mode (`/sse` + `/messages`)

## Setup

```bash
cd mcp/music-tools
npm install
```

Create or update mcp/music-tools/.env with required values:
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_DEFAULT_VOICE_ID` (recommended)

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

## GPT bridge

The `npm run gpt-agent` script turns an OpenAI chat model into an MCP client for your tunneled server. It uses OpenAI function calling to route GPT tool requests through the MCP transport and back to the model.

Requirements:

* `OPENAI_API_KEY` – API key for the OpenAI model you plan to use.
* `MCP_TUNNEL_URL` – the public URL for your tunnel (for example `https://sao-head-moore-albums.trycloudflare.com/mcp`).
* Optional: `OPENAI_MODEL` (defaults to `gpt-4o-mini`) and any `gpt-agent` arguments.

Usage:

```bash
OPENAI_API_KEY=sk_... MCP_TUNNEL_URL=https://.../mcp npm run gpt-agent -- "Validate my blueprint and synthesize a preview."
```

The script prints the MCP tool name and arguments chosen by GPT along with the tool outputs. Use it to iterate on prompts and verify `validate_blueprint` and `synthesize_preview` before wiring more advanced agents.

### Blueprint configuration

By default the bridge uses a fixed blueprint (id `demo-blueprint`, style `dreamy pop`) so GPT always has valid data. To inject your own blueprint, point `MCP_BLUEPRINT_JSON` at a JSON string or use the CLI to feed in a blueprint payload:

```bash
OPENAI_API_KEY=sk_... \
MCP_TUNNEL_URL=https://.../mcp \
MCP_BLUEPRINT_JSON='{"id":"custom","style":"space","tempo_bpm":90,"key":"F","sections":[{"name":"intro","bars":4}],"lyrics":"Custom lyrics here.","voice":{"voice_id":"21m00T1W"}}' \
npm run gpt-agent -- "Validate this blueprint and synthesize a preview."
```

The default blueprint is used whenever `MCP_BLUEPRINT_JSON` is missing, so simple prompts still work.
