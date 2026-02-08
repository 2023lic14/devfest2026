import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";
import dotenv from "dotenv";
import { Ajv2020 } from "ajv/dist/2020.js";
import draft2020Schema from "ajv/dist/refs/json-schema-2020-12/schema.json" with { type: "json" };

const FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(FILE_DIR, ".env") });

type Blueprint = {
  id: string;
  style: string;
  tempo_bpm: number;
  key: string;
  time_signature?: string;
  sections: { name: string; bars: number; energy?: number; prompt?: string }[];
  lyrics: string;
  voice: {
    voice_id: string;
    model_id?: string;
    stability?: number;
    similarity_boost?: number;
    style_exaggeration?: number;
    speaker_boost?: boolean;
  };
  metadata?: Record<string, unknown>;
};

function usage(): never {
  // eslint-disable-next-line no-console
  console.error("Usage: npm run audio:moment -- <audio_path> [--api http://127.0.0.1:8000] [--kind song|preview]");
  process.exit(2);
}

function assertEnv(variable: string): string {
  const value = process.env[variable];
  if (!value) {
    throw new Error(`Missing ${variable} environment variable.`);
  }
  return value;
}

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".aac") return "audio/aac";
  return "application/octet-stream";
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function clampFloat(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  return Math.max(min, Math.min(max, value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeBlueprint(input: unknown, options: { transcript?: string } = {}): Blueprint {
  const src = isPlainObject(input) ? input : {};
  const voiceId = process.env.ELEVENLABS_DEFAULT_VOICE_ID ?? "21m00T1W";
  const modelId = process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2";

  const sectionsRaw = Array.isArray(src.sections) ? src.sections : [];
  const collectedSectionLyrics: string[] = [];
  const sections = (sectionsRaw.length > 0 ? sectionsRaw : [{}]).map((raw, idx) => {
    const sec = isPlainObject(raw) ? raw : {};
    const name = typeof sec.name === "string" && sec.name.trim() ? sec.name.trim() : `section ${idx + 1}`;
    const bars = clampInt(sec.bars, 1, 256, 8);
    const energy = clampFloat(sec.energy, 0, 1);
    const prompt = typeof sec.prompt === "string" && sec.prompt.trim() ? sec.prompt.trim() : undefined;
    if (typeof (sec as any).lyrics === "string" && (sec as any).lyrics.trim()) {
      collectedSectionLyrics.push((sec as any).lyrics.trim());
    }
    return {
      name,
      bars,
      ...(typeof energy === "number" ? { energy } : {}),
      ...(prompt ? { prompt } : {})
    };
  });

  const topLyrics = typeof src.lyrics === "string" ? src.lyrics.trim() : "";
  const lyrics = topLyrics || collectedSectionLyrics.join("\n\n") || "Placeholder lyrics.";

  const voiceRaw = isPlainObject(src.voice) ? src.voice : {};
  const voice: Blueprint["voice"] = {
    voice_id: (typeof voiceRaw.voice_id === "string" && voiceRaw.voice_id.trim()) ? voiceRaw.voice_id.trim() : voiceId,
    model_id: (typeof voiceRaw.model_id === "string" && voiceRaw.model_id.trim()) ? voiceRaw.model_id.trim() : modelId
  };
  const stability = clampFloat((voiceRaw as any).stability, 0, 1);
  const similarityBoost = clampFloat((voiceRaw as any).similarity_boost, 0, 1);
  const styleExaggeration = clampFloat((voiceRaw as any).style_exaggeration, 0, 1);
  const speakerBoost = typeof (voiceRaw as any).speaker_boost === "boolean" ? (voiceRaw as any).speaker_boost : undefined;
  if (typeof stability === "number") voice.stability = stability;
  if (typeof similarityBoost === "number") voice.similarity_boost = similarityBoost;
  if (typeof styleExaggeration === "number") voice.style_exaggeration = styleExaggeration;
  if (typeof speakerBoost === "boolean") voice.speaker_boost = speakerBoost;

  const metadataRaw = isPlainObject(src.metadata) ? src.metadata : {};
  const metadata: Record<string, unknown> = { ...metadataRaw };
  if (options.transcript) {
    metadata.transcript = options.transcript;
  }

  const id = typeof src.id === "string" && src.id.trim() ? src.id.trim() : `moment-${Date.now()}`;
  const style = typeof src.style === "string" && src.style.trim() ? src.style.trim().slice(0, 120) : "original pop";
  const tempo_bpm = clampInt(src.tempo_bpm, 40, 220, 110);
  const key = typeof src.key === "string" && /^[A-G](#|b)?m?$/.test(src.key.trim()) ? src.key.trim() : "C";
  const time_signature =
    typeof src.time_signature === "string" && /^[1-9][0-9]?\/[1-9][0-9]?$/.test(src.time_signature.trim())
      ? src.time_signature.trim()
      : "4/4";

  return {
    id,
    style,
    tempo_bpm,
    key,
    time_signature,
    sections,
    lyrics,
    voice,
    metadata
  };
}

async function validateAgainstSchema(blueprint: unknown): Promise<void> {
  const schemaPath = path.resolve(process.cwd(), "../../docs/blueprint_schema.json");
  const raw = await readFile(schemaPath, "utf-8");
  const schema = JSON.parse(raw) as Record<string, unknown>;

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addMetaSchema(draft2020Schema as any);
  const validate = ajv.compile(schema);
  const ok = validate(blueprint);
  if (ok) return;

  const errors = (validate.errors ?? []).map((e) => `${e.instancePath || "/"}: ${e.message ?? "invalid"}`);
  throw new Error(`Generated blueprint did not match schema:\n${errors.join("\n")}`);
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as any).cause;
    const causeMsg =
      cause instanceof Error ? cause.message : (typeof cause === "string" ? cause : "");
    return causeMsg ? `${err.message} (cause: ${causeMsg})` : err.message;
  }
  return String(err);
}

async function transcribe(client: OpenAI, audioPath: string): Promise<string> {
  const bytes = await readFile(audioPath);
  const file = new File([new Blob([bytes], { type: guessMime(audioPath) })], path.basename(audioPath));
  try {
    const transcript = await client.audio.transcriptions.create({
      file,
      model: "gpt-4o-transcribe"
    });
    return transcript.text.trim();
  } catch (err) {
    throw new Error(`OpenAI transcription failed: ${formatError(err)}`);
  }
}

async function transcriptToBlueprint(client: OpenAI, transcript: string): Promise<Blueprint> {
  const voiceId = process.env.ELEVENLABS_DEFAULT_VOICE_ID ?? "21m00T1W";
  const modelId = process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2";
  const blueprintId = `moment-${Date.now()}`;

  const prompt = [
    "Generate a Song Blueprint JSON that conforms to:",
    "- required: id, style, tempo_bpm (40-220), key (A-G with optional #/b and optional m), sections (>=1), lyrics, voice.voice_id",
    "- optional: time_signature, section.energy (0-1), section.prompt, voice.model_id, voice.speaker_boost, metadata",
    "- do not include extra top-level keys besides: id, style, tempo_bpm, key, time_signature, sections, lyrics, voice, metadata",
    "- sections items MUST ONLY contain: name, bars, energy, prompt (no other keys, and do not put lyrics inside sections).",
    "",
    "Use a safe, original style description. Do not mention living artists.",
    "",
    "Example shape:",
    '{"id":"...","style":"...","tempo_bpm":110,"key":"C","time_signature":"4/4","sections":[{"name":"verse","bars":8,"energy":0.5,"prompt":"..." }],"lyrics":"...","voice":{"voice_id":"...","model_id":"eleven_multilingual_v2","speaker_boost":true},"metadata":{}}',
    "",
    `Transcript: """${transcript}"""`,
    "",
    `Return ONLY valid JSON. Use id "${blueprintId}". Use voice.voice_id "${voiceId}". Use voice.model_id "${modelId}".`
  ].join("\n");

  try {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.4
    });
    return JSON.parse(response.choices[0]?.message?.content ?? "{}") as Blueprint;
  } catch (err) {
    throw new Error(`OpenAI blueprint generation failed: ${formatError(err)}`);
  }
}

async function submitToApi(args: {
  apiBaseUrl: string;
  audioPath: string;
  blueprint: Blueprint;
  outputKind: string;
}) {
  const apiBaseUrl = args.apiBaseUrl.replace(/\/+$/, "");
  const audioBytes = await readFile(args.audioPath);
  const fileBlob = new Blob([audioBytes], { type: guessMime(args.audioPath) });

  const form = new FormData();
  form.set("file", fileBlob, path.basename(args.audioPath));
  form.set("blueprint_json", JSON.stringify(args.blueprint));
  form.set("output_kind", args.outputKind);

  let createResp: Response;
  try {
    createResp = await fetch(`${apiBaseUrl}/v1/create-moment`, { method: "POST", body: form });
  } catch (err) {
    throw new Error(`Backend fetch failed (POST ${apiBaseUrl}/v1/create-moment): ${formatError(err)}`);
  }
  if (!createResp.ok) {
    const body = await createResp.text().catch(() => "");
    throw new Error(`create-moment failed (${createResp.status}): ${body}`.trim());
  }
  const created = (await createResp.json()) as { job_id?: string };
  if (!created.job_id) throw new Error("create-moment response missing job_id");

  // eslint-disable-next-line no-console
  console.log(`job_id=${created.job_id}`);
  return created.job_id;
}

async function pollStatus(apiBaseUrl: string, jobId: string, timeoutMs = 10 * 60_000) {
  const base = apiBaseUrl.replace(/\/+$/, "");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let resp: Response;
    try {
      resp = await fetch(`${base}/v1/status/${jobId}`);
    } catch (err) {
      throw new Error(`Backend fetch failed (GET ${base}/v1/status/${jobId}): ${formatError(err)}`);
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`status failed (${resp.status}): ${body}`.trim());
    }
    const json = (await resp.json()) as any;
    const status = String(json.status ?? "");
    if (status === "COMPLETED") {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(json, null, 2));
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Timed out waiting for COMPLETED");
}

async function main() {
  const audioPath = process.argv[2];
  if (!audioPath) usage();

  const apiIdx = process.argv.indexOf("--api");
  const kindIdx = process.argv.indexOf("--kind");
  const apiBaseUrl =
    apiIdx >= 0 ? (process.argv[apiIdx + 1] ?? "") : (process.env.MOMENT_API_BASE_URL ?? "http://127.0.0.1:8000");
  const outputKind = (kindIdx >= 0 ? (process.argv[kindIdx + 1] ?? "") : "song") || "song";
  if (!apiBaseUrl) throw new Error("Missing --api value and MOMENT_API_BASE_URL is not set.");

  assertEnv("OPENAI_API_KEY");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // eslint-disable-next-line no-console
  console.log(`Using Node ${process.version}`);
  // eslint-disable-next-line no-console
  console.log(`API base: ${apiBaseUrl} output_kind=${outputKind}`);

  const transcript = await transcribe(client, audioPath);
  const rawBlueprint = await transcriptToBlueprint(client, transcript);
  const blueprint = sanitizeBlueprint(rawBlueprint, { transcript });
  await validateAgainstSchema(blueprint);

  const jobId = await submitToApi({ apiBaseUrl, audioPath, blueprint, outputKind });
  await pollStatus(apiBaseUrl, jobId);
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(formatError(err));
  process.exit(1);
});
