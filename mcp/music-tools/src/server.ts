import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { ErrorObject, ValidateFunction } from "ajv";
import dotenv from "dotenv";
import { z } from "zod";

// In local dev, it's common to have stale exported env vars that silently override .env.
// Default to letting `.env` win to reduce confusion when rotating keys during iteration.
dotenv.config({ override: true });

type JsonObject = Record<string, unknown>;
type TransportMode = "stdio" | "http";
type ActiveTransport = StreamableHTTPServerTransport | SSEServerTransport;
type BlueprintValidator = ValidateFunction<unknown>;
type ExpressLikeRequest = any;
type ExpressLikeResponse = any;
type ExpressNext = () => void;

interface RuntimeConfig {
  transport: TransportMode;
  httpHost: string;
  httpPort: number;
  httpPath: string;
  authToken?: string;
  enableLegacySse: boolean;
  enableJsonResponse: boolean;
  statelessHttp: boolean;
}

interface VoiceSettings {
  voice_id?: string;
  model_id?: string;
  stability?: number;
  similarity_boost?: number;
  style_exaggeration?: number;
  speaker_boost?: boolean;
}

interface BlueprintSection {
  name?: string;
  bars?: number;
  energy?: number;
  prompt?: string;
}

interface Blueprint extends JsonObject {
  id?: string;
  style?: string;
  tempo_bpm?: number;
  key?: string;
  time_signature?: string;
  metadata?: JsonObject;
  lyrics?: string;
  voice?: VoiceSettings;
  sections?: BlueprintSection[];
}

const FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), "tmp/audio-previews");
const DEFAULT_MODEL_ID = process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2";
const LEGACY_SSE_PATH = "/sse";
const LEGACY_SSE_MESSAGES_PATH = "/messages";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  return value.toLowerCase() === "true";
}

function parseTransportMode(): TransportMode {
  const arg = process.argv.find((item) => item.startsWith("--transport="));
  const argValue = arg?.split("=")[1];
  const raw = (argValue ?? process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  return raw === "http" ? "http" : "stdio";
}

function loadRuntimeConfig(): RuntimeConfig {
  return {
    transport: parseTransportMode(),
    httpHost: process.env.MCP_HTTP_HOST ?? "0.0.0.0",
    httpPort: Number(process.env.MCP_HTTP_PORT ?? "8080"),
    httpPath: process.env.MCP_HTTP_PATH ?? "/mcp",
    authToken: process.env.MCP_AUTH_TOKEN || undefined,
    enableLegacySse: parseBool(process.env.MCP_ENABLE_LEGACY_SSE, false),
    enableJsonResponse: parseBool(process.env.MCP_ENABLE_JSON_RESPONSE, false),
    statelessHttp: parseBool(process.env.MCP_HTTP_STATELESS, false)
  };
}

function resolveSchemaPath(): string {
  const envPath = process.env.BLUEPRINT_SCHEMA_PATH;
  const candidates = [
    envPath,
    path.resolve(process.cwd(), "../../docs/blueprint_schema.json"),
    path.resolve(process.cwd(), "docs/blueprint_schema.json"),
    path.resolve(FILE_DIR, "../../../docs/blueprint_schema.json")
  ].filter((value): value is string => Boolean(value));

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("Unable to locate docs/blueprint_schema.json. Set BLUEPRINT_SCHEMA_PATH.");
  }
  return found;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) {
    return [];
  }
  return errors.map((error) => {
    const location = error.instancePath || "/";
    return `${location}: ${error.message ?? "validation error"}`;
  });
}

function toolError(message: string, details?: JsonObject) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
    structuredContent: {
      ok: false,
      message,
      ...(details ?? {})
    }
  };
}

async function createMomentViaApi(args: {
  audio_url?: string;
  audio_path?: string;
  filename?: string;
  blueprint_json?: string;
  output_kind?: string;
  api_base_url?: string;
  poll_interval_ms?: number;
  timeout_ms?: number;
}) {
  const apiBaseUrl =
    (args.api_base_url ?? process.env.MOMENT_API_BASE_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
  const pollIntervalMs = Math.max(250, Math.min(10000, Math.floor(args.poll_interval_ms ?? 1500)));
  const timeoutMs = Math.max(5000, Math.min(20 * 60_000, Math.floor(args.timeout_ms ?? 180_000)));

  let audioBuffer: Buffer;
  let contentType = "application/octet-stream";
  let filename = (args.filename ?? "").trim();

  if (args.audio_url) {
    const response = await fetch(args.audio_url);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Unable to download audio_url (status ${response.status}): ${body}`.trim());
    }
    contentType = response.headers.get("content-type") ?? contentType;
    const urlName = (() => {
      try {
        const url = new URL(args.audio_url);
        const basename = path.posix.basename(url.pathname);
        return basename && basename !== "/" ? basename : "";
      } catch {
        return "";
      }
    })();
    filename = filename || urlName || `moment-${Date.now()}.bin`;
    audioBuffer = Buffer.from(await response.arrayBuffer());
  } else if (args.audio_path) {
    audioBuffer = await readFile(args.audio_path);
    filename = filename || path.basename(args.audio_path);
  } else {
    throw new Error("Provide audio_url or audio_path.");
  }

  // Node's fetch supports FormData; we avoid extra deps.
  const form = new FormData();
  const arrayBuffer = audioBuffer.buffer.slice(
    audioBuffer.byteOffset,
    audioBuffer.byteOffset + audioBuffer.byteLength
  ) as ArrayBuffer;
  const blob = new Blob([arrayBuffer], { type: contentType });
  form.set("file", blob, filename);
  if (typeof args.blueprint_json === "string" && args.blueprint_json.trim().length > 0) {
    form.set("blueprint_json", args.blueprint_json.trim());
  }
  if (typeof args.output_kind === "string" && args.output_kind.trim().length > 0) {
    form.set("output_kind", args.output_kind.trim());
  }

  const createResponse = await fetch(`${apiBaseUrl}/v1/create-moment`, {
    method: "POST",
    body: form
  });
  if (!createResponse.ok) {
    const body = await createResponse.text().catch(() => "");
    throw new Error(`API create-moment failed (status ${createResponse.status}): ${body}`.trim());
  }

  const created = (await createResponse.json()) as { job_id?: string };
  const jobId = created.job_id;
  if (!jobId) {
    throw new Error("API create-moment response missing job_id.");
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const statusResp = await fetch(`${apiBaseUrl}/v1/status/${jobId}`);
    if (!statusResp.ok) {
      const body = await statusResp.text().catch(() => "");
      throw new Error(`API status failed (status ${statusResp.status}): ${body}`.trim());
    }
    const statusJson = (await statusResp.json()) as Record<string, unknown>;
    const status = String(statusJson["status"] ?? "");
    if (status === "COMPLETED") {
      return { job_id: jobId, status_json: statusJson };
    }
    await sleep(pollIntervalMs);
  }

  return { job_id: jobId, timeout: true };
}

function pickNumber(
  direct: number | undefined,
  fromBlueprint: number | undefined
): number | undefined {
  if (typeof direct === "number") {
    return direct;
  }
  if (typeof fromBlueprint === "number") {
    return fromBlueprint;
  }
  return undefined;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function looksLikeJsonPayload(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function parseJsonObject(value: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return parsed as JsonObject;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function extractPromptSuggestion(errorBody: string): string | undefined {
  const parsed = parseJsonObject(errorBody);
  const detail = parsed?.detail;
  if (!detail || typeof detail !== "object") {
    return undefined;
  }
  const data = (detail as JsonObject).data;
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const suggestion = (data as JsonObject).prompt_suggestion;
  if (typeof suggestion !== "string") {
    return undefined;
  }
  const trimmed = suggestion.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractErrorStatus(errorBody: string): string | undefined {
  const parsed = parseJsonObject(errorBody);
  const detail = parsed?.detail;
  if (!detail || typeof detail !== "object") {
    return undefined;
  }
  const status = (detail as JsonObject).status;
  return typeof status === "string" ? status : undefined;
}

function sanitizeStyleDescriptor(style: string | undefined): string | undefined {
  if (!style) {
    return undefined;
  }
  const cleaned = style
    .replace(/\binspired by\b[^.?!]*/gi, "")
    .replace(/\bin the style of\b[^.?!]*/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim()
    .replace(/^[,.;:\-\s]+|[,.;:\-\s]+$/g, "");

  return cleaned || undefined;
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function isAuthorizedRequest(req: {
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  const requiredToken = process.env.MCP_AUTH_TOKEN;
  if (!requiredToken) {
    return true;
  }
  const authHeader = getHeaderValue(req.headers.authorization);
  if (!authHeader) {
    return false;
  }
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return false;
  }
  return match[1] === requiredToken;
}

async function loadBlueprintValidator() {
  const schemaPath = resolveSchemaPath();
  const raw = await readFile(schemaPath, "utf-8");
  const schema = JSON.parse(raw) as JsonObject;

  const ajv = new Ajv2020({
    allErrors: true,
    strict: false
  });
  const validate = ajv.compile(schema);
  return { schemaPath, validate };
}

async function synthesizePreview(args: {
  text?: string;
  blueprint?: Blueprint;
  voice_id?: string;
  model_id?: string;
  stability?: number;
  similarity_boost?: number;
  style_exaggeration?: number;
  speaker_boost?: boolean;
}, outputPrefix = "preview") {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return toolError("Missing ELEVENLABS_API_KEY.");
  }

  const blueprintVoice = args.blueprint?.voice;
  const text = args.text ?? args.blueprint?.lyrics;
  const voiceId =
    args.voice_id ?? blueprintVoice?.voice_id ?? process.env.ELEVENLABS_DEFAULT_VOICE_ID;
  const modelId = args.model_id ?? blueprintVoice?.model_id ?? DEFAULT_MODEL_ID;

  if (!text || text.trim().length === 0) {
    return toolError("Missing text. Provide `text` or `blueprint.lyrics`.");
  }
  if (!voiceId) {
    return toolError("Missing voice id. Provide `voice_id` or set ELEVENLABS_DEFAULT_VOICE_ID.");
  }

  const outputDir = process.env.ELEVENLABS_OUTPUT_DIR || DEFAULT_OUTPUT_DIR;
  await mkdir(outputDir, { recursive: true });

  const voiceSettings = {
    stability: pickNumber(args.stability, blueprintVoice?.stability),
    similarity_boost: pickNumber(args.similarity_boost, blueprintVoice?.similarity_boost),
    style: pickNumber(args.style_exaggeration, blueprintVoice?.style_exaggeration),
    use_speaker_boost:
      args.speaker_boost ?? blueprintVoice?.speaker_boost ?? true
  };

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "content-type": "application/json",
      accept: "audio/mpeg"
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: voiceSettings
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    return toolError("ElevenLabs synthesis failed.", {
      status: response.status,
      response_body: errorBody
    });
  }

  const audio = new Uint8Array(await response.arrayBuffer());
  const filename = `${outputPrefix}-${Date.now()}-${randomUUID().slice(0, 8)}.mp3`;
  const outputPath = path.resolve(outputDir, filename);
  await writeFile(outputPath, audio);

  return {
    content: [
      {
        type: "text" as const,
        text: `Preview synthesized successfully: ${outputPath}`
      }
    ],
    structuredContent: {
      ok: true,
      output_path: outputPath,
      bytes: audio.byteLength,
      mime_type: "audio/mpeg",
      output_kind: outputPrefix,
      voice_id: voiceId,
      model_id: modelId
    }
  };
}

function buildMusicPromptFromBlueprint(
  blueprint: Blueprint,
  options?: {
    forceInstrumental?: boolean;
    prompt?: string;
  }
): string | undefined {
  if (options?.prompt?.trim() && !looksLikeJsonPayload(options.prompt)) {
    return options.prompt.trim();
  }

  const sections = Array.isArray(blueprint.sections) ? blueprint.sections : [];
  const sectionSummary = sections
    .map((section) => {
      const name = section.name?.trim() || "section";
      const bars = typeof section.bars === "number" ? `${section.bars} bars` : "bars unspecified";
      const energy =
        typeof section.energy === "number" ? `energy ${section.energy.toFixed(2)}` : "energy flexible";
      return `${name} (${bars}, ${energy})`;
    })
    .join(", ");

  const mood =
    blueprint.metadata && typeof blueprint.metadata.mood === "string"
      ? blueprint.metadata.mood
      : undefined;

  const lines = [
    "Compose a complete, studio-quality song with instrumentation and sung vocals.",
    blueprint.style ? `Style/genre: ${blueprint.style}.` : undefined,
    blueprint.tempo_bpm ? `Tempo: ${blueprint.tempo_bpm} BPM.` : undefined,
    blueprint.key ? `Key center: ${blueprint.key}.` : undefined,
    blueprint.time_signature ? `Time signature: ${blueprint.time_signature}.` : undefined,
    mood ? `Mood: ${mood}.` : undefined,
    sectionSummary ? `Song sections: ${sectionSummary}.` : undefined,
    options?.forceInstrumental ? "Make this fully instrumental (no vocals)." : "Include clear lead vocals.",
    blueprint.lyrics ? "Use the following lyrics as the vocal topline and keep wording close:" : undefined,
    blueprint.lyrics?.trim()
  ].filter((line): line is string => Boolean(line));

  if (lines.length === 0) {
    return undefined;
  }

  return lines.join("\n\n");
}

function buildPolicySafePromptFromBlueprint(
  blueprint: Blueprint,
  options?: {
    forceInstrumental?: boolean;
  }
): string | undefined {
  const sections = Array.isArray(blueprint.sections) ? blueprint.sections : [];
  const sectionSummary = sections
    .map((section) => {
      const name = section.name?.trim() || "section";
      const bars = typeof section.bars === "number" ? `${section.bars} bars` : "bars unspecified";
      const energy =
        typeof section.energy === "number" ? `energy ${section.energy.toFixed(2)}` : "energy flexible";
      return `${name} (${bars}, ${energy})`;
    })
    .join(", ");

  const mood =
    blueprint.metadata && typeof blueprint.metadata.mood === "string"
      ? blueprint.metadata.mood
      : undefined;

  const sanitizedStyle =
    sanitizeStyleDescriptor(blueprint.style) ??
    "catchy pop-folk with introspective, poetic storytelling";

  const lines = [
    "Compose a complete, studio-quality song with instrumentation and sung vocals.",
    `Style/genre: ${sanitizedStyle}.`,
    blueprint.tempo_bpm ? `Tempo: ${blueprint.tempo_bpm} BPM.` : undefined,
    blueprint.key ? `Key center: ${blueprint.key}.` : undefined,
    blueprint.time_signature ? `Time signature: ${blueprint.time_signature}.` : undefined,
    mood ? `Mood: ${mood}.` : undefined,
    sectionSummary ? `Song sections: ${sectionSummary}.` : undefined,
    "Keep it original and avoid imitating or referencing any specific named artist.",
    options?.forceInstrumental ? "Make this fully instrumental (no vocals)." : "Include clear lead vocals.",
    blueprint.lyrics ? "Use the following lyrics as the vocal topline and keep wording close:" : undefined,
    blueprint.lyrics?.trim()
  ].filter((line): line is string => Boolean(line));

  if (lines.length === 0) {
    return undefined;
  }

  return lines.join("\n\n");
}

function estimateMusicLengthMs(blueprint: Blueprint, requestedLengthMs?: number): number {
  if (typeof requestedLengthMs === "number") {
    return clampInteger(requestedLengthMs, 10000, 300000);
  }

  const bpm = typeof blueprint.tempo_bpm === "number" ? blueprint.tempo_bpm : 100;
  const [numeratorRaw] = (blueprint.time_signature ?? "4/4").split("/");
  const beatsPerBar = Number(numeratorRaw) || 4;
  const totalBars = (Array.isArray(blueprint.sections) ? blueprint.sections : []).reduce((acc, section) => {
    return acc + (typeof section.bars === "number" ? section.bars : 0);
  }, 0);
  const fallbackBars = totalBars > 0 ? totalBars : 32;
  const beatMs = 60000 / bpm;
  const estimated = fallbackBars * beatsPerBar * beatMs;

  return clampInteger(estimated, 10000, 300000);
}

function outputFormatToExtension(outputFormat: string): string {
  const prefix = outputFormat.split("_")[0]?.toLowerCase();
  if (!prefix) {
    return "mp3";
  }
  if (prefix === "mp3") {
    return "mp3";
  }
  if (prefix === "pcm") {
    return "pcm";
  }
  if (prefix === "ulaw" || prefix === "mulaw") {
    return "ulaw";
  }
  return prefix;
}

function outputFormatToMimeType(outputFormat: string): string {
  const prefix = outputFormat.split("_")[0]?.toLowerCase();
  if (prefix === "mp3") {
    return "audio/mpeg";
  }
  return "application/octet-stream";
}

async function composeSongWithElevenMusic(args: {
  blueprint: Blueprint;
  prompt?: string;
  model_id?: string;
  music_length_ms?: number;
  force_instrumental?: boolean;
  output_format?: string;
}) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return toolError("Missing ELEVENLABS_API_KEY.");
  }

  const outputDir = process.env.ELEVENLABS_OUTPUT_DIR || DEFAULT_OUTPUT_DIR;
  await mkdir(outputDir, { recursive: true });

  const outputFormat = args.output_format ?? process.env.ELEVENLABS_MUSIC_OUTPUT_FORMAT ?? "mp3_44100_128";
  const defaultMusicModelId = process.env.ELEVENLABS_MUSIC_MODEL_ID ?? "music_v1";
  const requestedModelId = args.model_id?.trim();
  const modelId =
    requestedModelId && requestedModelId.toLowerCase().startsWith("music")
      ? requestedModelId
      : defaultMusicModelId;
  const forceInstrumental = args.force_instrumental ?? false;
  const musicLengthMs = estimateMusicLengthMs(args.blueprint, args.music_length_ms);

  const prompt = buildMusicPromptFromBlueprint(args.blueprint, {
    forceInstrumental,
    prompt: args.prompt
  });
  if (!prompt) {
    return toolError("Missing song prompt. Provide `prompt` or blueprint fields (style/lyrics/sections).");
  }

  const params = new URLSearchParams({ output_format: outputFormat });
  const requestSong = async (promptText: string) => {
    return fetch(`https://api.elevenlabs.io/v1/music?${params.toString()}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        prompt: promptText,
        model_id: modelId,
        music_length_ms: musicLengthMs,
        force_instrumental: forceInstrumental
      })
    });
  };

  let promptUsed = prompt;
  let moderationFallbackApplied = false;
  let response = await requestSong(promptUsed);

  if (!response.ok) {
    const errorBody = await response.text();
    const errorStatus = extractErrorStatus(errorBody);
    const isBadPrompt = response.status === 400 && errorStatus === "bad_prompt";
    const suggestedPrompt = extractPromptSuggestion(errorBody);
    const safeFallbackPrompt = buildPolicySafePromptFromBlueprint(args.blueprint, {
      forceInstrumental
    });
    const retryPrompt = suggestedPrompt ?? safeFallbackPrompt;

    if (isBadPrompt && retryPrompt && retryPrompt !== promptUsed) {
      promptUsed = retryPrompt;
      moderationFallbackApplied = true;
      response = await requestSong(promptUsed);
      if (!response.ok) {
        const retryErrorBody = await response.text();
        return toolError("ElevenLabs music composition failed.", {
          status: response.status,
          response_body: retryErrorBody,
          moderation_fallback_applied: moderationFallbackApplied,
          original_prompt_rejected: true
        });
      }
    } else {
      return toolError("ElevenLabs music composition failed.", {
        status: response.status,
        response_body: errorBody,
        prompt_suggestion: suggestedPrompt,
        original_prompt_rejected: isBadPrompt
      });
    }
  }

  const audio = new Uint8Array(await response.arrayBuffer());
  const extension = outputFormatToExtension(outputFormat);
  const filename = `song-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
  const outputPath = path.resolve(outputDir, filename);
  await writeFile(outputPath, audio);

  return {
    content: [
      {
        type: "text" as const,
        text: `Song composed successfully: ${outputPath}`
      }
    ],
    structuredContent: {
      ok: true,
      output_path: outputPath,
      bytes: audio.byteLength,
      mime_type: outputFormatToMimeType(outputFormat),
      output_kind: "song",
      model_id: modelId,
      output_format: outputFormat,
      music_length_ms: musicLengthMs,
      force_instrumental: forceInstrumental,
      moderation_fallback_applied: moderationFallbackApplied,
      prompt_used: promptUsed
    }
  };
}

function createMusicToolsServer(input: {
  schemaPath: string;
  validateBlueprint: BlueprintValidator;
}) {
  const server = new McpServer({
    name: "music-tools",
    version: "0.2.0"
  });

  server.tool(
    "validate_blueprint",
    "Validate a blueprint payload against docs/blueprint_schema.json",
    {
      blueprint: z.record(z.unknown())
    },
    async ({ blueprint }) => {
      const isValid = input.validateBlueprint(blueprint);
      const errors = formatAjvErrors(input.validateBlueprint.errors);

      if (!isValid) {
        return toolError("Blueprint validation failed.", {
          schema_path: input.schemaPath,
          errors
        });
      }

      return {
        content: [{ type: "text" as const, text: "Blueprint is valid." }],
        structuredContent: {
          ok: true,
          schema_path: input.schemaPath,
          errors: []
        }
      };
    }
  );

  server.tool(
    "synthesize_preview",
    "Generate a short ElevenLabs preview from text or blueprint.lyrics and write it to disk.",
    {
      text: z.string().min(1).optional(),
      blueprint: z.record(z.unknown()).optional(),
      voice_id: z.string().min(1).optional(),
      model_id: z.string().min(1).optional(),
      stability: z.number().min(0).max(1).optional(),
      similarity_boost: z.number().min(0).max(1).optional(),
      style_exaggeration: z.number().min(0).max(1).optional(),
      speaker_boost: z.boolean().optional()
    },
    async (args) => {
      const blueprint = args.blueprint as Blueprint | undefined;
      if (blueprint) {
        const blueprintIsValid = input.validateBlueprint(blueprint);
        if (!blueprintIsValid) {
          return toolError("Blueprint validation failed before synthesis.", {
            errors: formatAjvErrors(input.validateBlueprint.errors)
          });
        }
      }

      return synthesizePreview({
        ...args,
        blueprint
      });
    }
  );

  server.tool(
    "create_song",
    "Create a full song with ElevenLabs Music (instrumental + optional vocals) from a blueprint.",
    {
      blueprint: z.record(z.unknown()),
      prompt: z.string().min(1).optional(),
      model_id: z.string().min(1).optional(),
      music_length_ms: z.number().int().min(10000).max(300000).optional(),
      force_instrumental: z.boolean().optional(),
      output_format: z.string().min(1).optional()
    },
    async (args) => {
      const blueprint = args.blueprint as Blueprint;
      const blueprintIsValid = input.validateBlueprint(blueprint);
      if (!blueprintIsValid) {
        return toolError("Blueprint validation failed before song creation.", {
          errors: formatAjvErrors(input.validateBlueprint.errors)
        });
      }

      return composeSongWithElevenMusic({
        blueprint,
        prompt: args.prompt,
        model_id: args.model_id,
        music_length_ms: args.music_length_ms,
        force_instrumental: args.force_instrumental,
        output_format: args.output_format
      });
    }
  );

  server.tool(
    "create_moment",
    "Upload an audio file to the API /v1/create-moment pipeline and poll until completion.",
    {
      audio_url: z.string().min(1).optional(),
      audio_path: z.string().min(1).optional(),
      filename: z.string().min(1).optional(),
      blueprint_json: z.string().min(1).optional(),
      output_kind: z.string().min(1).optional(),
      api_base_url: z.string().min(1).optional(),
      poll_interval_ms: z.number().int().min(250).max(10000).optional(),
      timeout_ms: z.number().int().min(5000).max(20 * 60_000).optional()
    },
    async (args) => {
      try {
        const result = await createMomentViaApi({
          audio_url: args.audio_url,
          audio_path: args.audio_path,
          filename: args.filename,
          blueprint_json: args.blueprint_json,
          output_kind: args.output_kind,
          api_base_url: args.api_base_url,
          poll_interval_ms: args.poll_interval_ms,
          timeout_ms: args.timeout_ms
        });

        if ((result as any).timeout) {
          return toolError("Timed out waiting for the moment pipeline to complete.", {
            job_id: (result as any).job_id
          });
        }

        const statusJson = (result as any).status_json as Record<string, unknown> | undefined;
        const finalAudioUrl = statusJson ? statusJson["final_audio_url"] : undefined;

        return {
          content: [
            {
              type: "text" as const,
              text: typeof finalAudioUrl === "string" && finalAudioUrl
                ? `Moment completed. final_audio_url: ${finalAudioUrl}`
                : "Moment completed."
            }
          ],
          structuredContent: {
            ok: true,
            job_id: (result as any).job_id,
            status: statusJson?.["status"],
            final_audio_url: finalAudioUrl,
            status_json: statusJson
          }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError("Moment pipeline request failed.", { error: message });
      }
    }
  );

  return server;
}

async function runStdioServer(input: {
  schemaPath: string;
  validateBlueprint: BlueprintValidator;
}) {
  const server = createMusicToolsServer(input);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[music-tools] MCP stdio server started (schema: ${input.schemaPath})`);
}

async function runHttpServer(
  input: {
    schemaPath: string;
    validateBlueprint: BlueprintValidator;
  },
  config: RuntimeConfig
) {
  const app = createMcpExpressApp({ host: config.httpHost });
  const transports: Record<string, ActiveTransport> = {};
  const sessionServers: Record<string, McpServer> = {};
  let statelessServer: McpServer | null = null;
  let statelessTransport: StreamableHTTPServerTransport | null = null;
  let statelessInitPromise: Promise<void> | null = null;

  const ensureStatelessTransportReady = async () => {
    if (statelessServer && statelessTransport && !statelessInitPromise) {
      return;
    }

    if (!statelessInitPromise) {
      const server = createMusicToolsServer(input);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: config.enableJsonResponse
      });

      statelessServer = server;
      statelessTransport = transport;

      statelessInitPromise = (async () => {
        await server.connect(transport);
      })()
        .catch((error) => {
          statelessServer = null;
          statelessTransport = null;
          throw error;
        })
        .finally(() => {
          statelessInitPromise = null;
        });
    }

    await statelessInitPromise;
  };

  const releaseSessionReferences = (sessionId: string) => {
    delete transports[sessionId];
    delete sessionServers[sessionId];
  };

  const closeSessionServer = async (sessionId: string) => {
    const server = sessionServers[sessionId];
    if (server) {
      await server.close().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[music-tools] failed to close session server ${sessionId}: ${message}`);
      });
    }
    releaseSessionReferences(sessionId);
  };

  app.get("/healthz", (_req: ExpressLikeRequest, res: ExpressLikeResponse) => {
    res.status(200).json({
      ok: true,
      transport: "http",
      path: config.httpPath
    });
  });

  app.use(config.httpPath, (req: ExpressLikeRequest, res: ExpressLikeResponse, next: ExpressNext) => {
    if (isAuthorizedRequest(req)) {
      next();
      return;
    }
    res.status(401).json({
      error: "Unauthorized",
      message: "Provide Authorization: Bearer <MCP_AUTH_TOKEN>."
    });
  });

  app.all(config.httpPath, async (req: ExpressLikeRequest, res: ExpressLikeResponse) => {
    try {
      if (config.statelessHttp) {
        await ensureStatelessTransportReady();
        if (!statelessTransport) {
          throw new Error("Stateless transport is not initialized.");
        }
        await statelessTransport.handleRequest(req, res, req.body);
        return;
      }

      const sessionId = getHeaderValue(req.headers["mcp-session-id"]);
      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId && transports[sessionId]) {
        const existingTransport = transports[sessionId];
        if (existingTransport instanceof StreamableHTTPServerTransport) {
          transport = existingTransport;
        } else {
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Session exists but uses a different transport protocol."
            },
            id: null
          });
          return;
        }
      } else if (
        req.method === "POST" &&
        isInitializeRequest(req.body) &&
        !sessionId
      ) {
        const sessionServer = createMusicToolsServer(input);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: config.enableJsonResponse,
          onsessioninitialized: (newSessionId) => {
            transports[newSessionId] = transport!;
            sessionServers[newSessionId] = sessionServer;
            console.error(`[music-tools] streamable-http session initialized: ${newSessionId}`);
          }
        });

        transport.onclose = () => {
          const sid = transport?.sessionId;
          if (sid) {
            releaseSessionReferences(sid);
          }
        };

        await sessionServer.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "No valid MCP session. Send an initialize request first."
          },
          id: null
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[music-tools] error handling HTTP MCP request: ${message}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error"
          },
          id: null
        });
      }
    }
  });

  if (config.enableLegacySse) {
    app.use(
      [LEGACY_SSE_PATH, LEGACY_SSE_MESSAGES_PATH],
      (req: ExpressLikeRequest, res: ExpressLikeResponse, next: ExpressNext) => {
        if (isAuthorizedRequest(req)) {
          next();
          return;
        }
        res.status(401).send("Unauthorized");
      }
    );

    app.get(LEGACY_SSE_PATH, async (_req: ExpressLikeRequest, res: ExpressLikeResponse) => {
      const transport = new SSEServerTransport(LEGACY_SSE_MESSAGES_PATH, res);
      transports[transport.sessionId] = transport;

      res.on("close", () => {
        const sid = transport.sessionId;
        void closeSessionServer(sid);
      });

      const sessionServer = createMusicToolsServer(input);
      sessionServers[transport.sessionId] = sessionServer;
      await sessionServer.connect(transport);
    });

    app.post(LEGACY_SSE_MESSAGES_PATH, async (req: ExpressLikeRequest, res: ExpressLikeResponse) => {
      const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
      const transport = sessionId ? transports[sessionId] : undefined;

      if (!(transport instanceof SSEServerTransport)) {
        res.status(400).send("No SSE session found for sessionId.");
        return;
      }

      await transport.handlePostMessage(req, res, req.body);
    });
  }

  const httpServer = app.listen(config.httpPort, config.httpHost, () => {
    const authEnabled = Boolean(config.authToken);
    console.error(
      `[music-tools] MCP HTTP server listening on http://${config.httpHost}:${config.httpPort}${config.httpPath}`
    );
    console.error(`[music-tools] Health endpoint: http://${config.httpHost}:${config.httpPort}/healthz`);
    console.error(
      `[music-tools] Auth: ${
        authEnabled ? "enabled (Authorization: Bearer ... required)" : "disabled"
      }`
    );
    if (config.enableLegacySse) {
      console.error(
        `[music-tools] Legacy SSE enabled (${LEGACY_SSE_PATH}, ${LEGACY_SSE_MESSAGES_PATH})`
      );
    }
    if (config.statelessHttp) {
      console.error("[music-tools] Stateless HTTP mode enabled (no MCP session header required).");
    }
  });

  let shutdownPromise: Promise<void> | null = null;

  const shutdown = async () => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      console.error("[music-tools] shutting down...");
      if (statelessTransport) {
        statelessTransport.onclose = undefined;
        await statelessTransport.close().catch(() => undefined);
      }
      if (statelessServer) {
        await statelessServer.close().catch(() => undefined);
      }
      statelessTransport = null;
      statelessServer = null;
      statelessInitPromise = null;

      for (const sessionId of Object.keys(transports)) {
        const transport = transports[sessionId];
        transport.onclose = undefined;
        await transport.close().catch(() => undefined);
        await closeSessionServer(sessionId);
      }
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    })();

    await shutdownPromise;
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

async function main() {
  const config = loadRuntimeConfig();
  const { schemaPath, validate } = await loadBlueprintValidator();

  if (config.transport === "http") {
    await runHttpServer(
      {
        schemaPath,
        validateBlueprint: validate
      },
      config
    );
    return;
  }

  await runStdioServer({
    schemaPath,
    validateBlueprint: validate
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[music-tools] fatal error: ${message}`);
  process.exit(1);
});
