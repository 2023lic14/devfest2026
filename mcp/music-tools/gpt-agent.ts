import OpenAI from "openai";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import dotenv from "dotenv";

const FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(FILE_DIR, ".env") });

type ToolResult = Record<string, unknown> | { isError?: boolean };

type FunctionDef = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
};

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

type CreateSongArgs = {
  blueprint?: Blueprint;
  prompt?: string;
  model_id?: string;
  music_length_ms?: number;
  force_instrumental?: boolean;
  output_format?: string;
};

const defaultBlueprint: Blueprint = {
  id: "demo-blueprint",
  style: "catchy pop-folk inspired by Taylor Swift and the introspective poetics of Virginia Woolf and Sylvia Plath",
  tempo_bpm: 104,
  key: "G",
  time_signature: "4/4",
  sections: [
    { name: "intro", bars: 4, energy: 0.45, prompt: "Start with fingerpicked acoustic guitar and warm room tone." },
    { name: "verse 1", bars: 8, energy: 0.62, prompt: "Narrative vocal with intimate phrasing and diary-like detail." },
    { name: "pre-chorus", bars: 4, energy: 0.72, prompt: "Raise tension with stacked harmonies and subtle percussion lift." },
    { name: "chorus", bars: 8, energy: 0.9, prompt: "Deliver a sticky, sing-along hook with bright pop-folk momentum." },
    { name: "verse 2", bars: 8, energy: 0.68, prompt: "Expand the story with sharper imagery and emotional contrast." },
    { name: "bridge", bars: 6, energy: 0.78, prompt: "Lean introspective with poetic language, then build toward release." },
    { name: "final chorus", bars: 8, energy: 0.95, prompt: "Big final hook with layered harmonies and driving acoustic rhythm." },
    { name: "outro", bars: 4, energy: 0.55, prompt: "Resolve softly with lingering vocal ad-libs and guitar decay." }
  ],
  lyrics: `Verse 1
I wrote your name in the margin of a Thursday night,
Streetlamp gold on the page like a small, brave light.
Every word I erase still remembers your sound,
Like a secret I swore I would never write down.

Pre-Chorus
I keep circling the same moon,
Trying not to call it fate too soon.

Chorus
Meet me on 18th, where the summer wind still knows us,
Spinning little promises like petals in the dust.
If love is a poem, then I want the messy draft,
Heart on the line, no looking back.
Meet me on 18th, and if the night pulls fast,
Sing it like forever in a photograph.

Verse 2
Your voice is midnight blue with a wildfire edge,
Soft as a confession, sharp as a final sentence.
I wore my doubt like velvet, black ribbon, tight,
But you turned every heavy thought to a spark in flight.

Bridge
I was the girl at the window counting all the rain,
Now I am running barefoot through it, calling out your name.
If all the old ghosts listen, let them hear me laugh,
I chose the living line, not the aftermath.

Final Chorus
Meet me on 18th, where the city learns our chorus,
Every broken maybe turning into something for us.
If love is a poem, then I want the messy draft,
Heart on the line, no looking back.
Meet me on 18th, and when the night runs past,
Hold me like a headline, burn me into glass.`,
  voice: {
    voice_id: process.env.ELEVENLABS_DEFAULT_VOICE_ID ?? "21m00T1W",
    model_id: process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2",
    stability: 0.6,
    similarity_boost: 0.35,
    style_exaggeration: 0.3,
    speaker_boost: true
  },
  metadata: {
    mood: "wistful, romantic, and defiant",
    intent: "catchy pop-folk narrative demo"
  }
};

const functions: FunctionDef[] = [
  {
    name: "validate_blueprint",
    description: "Validates a blueprint payload against docs/blueprint_schema.json.",
    parameters: {
      type: "object",
      properties: {
        blueprint: {
          type: "object",
          description: "The blueprint object to validate (id, style, sections, lyrics, voice, etc.)."
        }
      },
      required: ["blueprint"]
    }
  },
  {
    name: "synthesize_preview",
    description: "Calls ElevenLabs to synthesize a short preview from text or blueprint.lyrics.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Plain text to convert to speech." },
        blueprint: { type: "object", description: "(Optional) Blueprint to validate and supply lyrics." },
        voice_id: { type: "string", description: "ElevenLabs voice_id override." },
        model_id: { type: "string", description: "Optional model override." },
        stability: { type: "number", description: "Between 0 and 1." },
        similarity_boost: { type: "number", description: "Between 0 and 1." },
        style_exaggeration: { type: "number", description: "Between 0 and 1." },
        speaker_boost: { type: "boolean", description: "Enable speaker boost." }
      }
    }
  },
  {
    name: "create_song",
    description: "Creates a full song with ElevenLabs Music (instrumental + optional vocals) from a blueprint.",
    parameters: {
      type: "object",
      properties: {
        blueprint: { type: "object", description: "Blueprint with lyrics, sections, and voice config." },
        prompt: { type: "string", description: "Optional direct music prompt override." },
        model_id: { type: "string", description: "Optional model override." },
        music_length_ms: { type: "number", description: "Requested song duration in milliseconds." },
        force_instrumental: { type: "boolean", description: "When true, generate instrumental only." },
        output_format: { type: "string", description: "Audio format such as mp3_44100_128." }
      },
      required: ["blueprint"]
    }
  }
];

function assertEnv(variable: string): string {
  const value = process.env[variable];
  if (!value) {
    throw new Error(`Missing ${variable} environment variable.`);
  }
  return value;
}

function loadBlueprint(): Blueprint {
  const raw = process.env.MCP_BLUEPRINT_JSON;
  if (!raw) {
    return defaultBlueprint;
  }
  return JSON.parse(raw) as Blueprint;
}

async function callTool(
  client: Client,
  functionName: string,
  args: Record<string, unknown>,
  options?: { timeoutMs?: number }
) {
  const toolArguments: Record<string, unknown> = { ...args };

  const requestOptions =
    typeof options?.timeoutMs === "number"
      ? { timeout: options.timeoutMs, maxTotalTimeout: options.timeoutMs }
      : undefined;

  const result = await client.callTool({ name: functionName, arguments: toolArguments }, undefined, requestOptions);
  return result;
}

async function storePreviewFile(originalPath: string): Promise<string | undefined> {
  if (!originalPath) {
    return undefined;
  }

  try {
    const destDir = path.resolve(process.cwd(), "../tmp/audio-previews");
    await mkdir(destDir, { recursive: true });
    const destPath = path.join(
      destDir,
      `${Date.now()}-${path.basename(originalPath)}`
    );
    await copyFile(originalPath, destPath);
    return destPath;
  } catch (error) {
    console.warn("Unable to copy preview file:", error);
    return undefined;
  }
}

async function executeToolAndStore(
  client: Client,
  functionName: string,
  functionArgs: Record<string, unknown>,
  blueprint: Blueprint
) {
  const timeoutMs =
    functionName === "create_song"
      ? Number(process.env.MCP_CREATE_SONG_TIMEOUT_MS ?? 300000)
      : Number(process.env.MCP_TOOL_TIMEOUT_MS ?? 60000);
  const toolResult = await callTool(client, functionName, functionArgs, { timeoutMs });
  if (typeof toolResult === "object" && toolResult) {
    const structured = (toolResult as any).structuredContent;
    if (structured?.ok === false) {
      console.error(
        `MCP tool ${functionName} returned error:`,
        JSON.stringify(structured, null, 2)
      );
    }
  }
  let storedAudioPath: string | undefined;
  if (functionName === "synthesize_preview" || functionName === "create_song") {
    const structured = typeof toolResult === "object" && toolResult ? (toolResult as any).structuredContent : undefined;
    if (structured?.output_path && typeof structured.output_path === "string") {
      storedAudioPath = await storePreviewFile(structured.output_path);
    }
  }
  const baseContent = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult, null, 2);
  const toolMessageContent = storedAudioPath
    ? `${baseContent}\nStored preview copy: ${storedAudioPath}`
    : baseContent;
  if (storedAudioPath) {
    console.log(`Preview copied to ${storedAudioPath}`);
  }
  const message: {
    role: "function";
    name: string;
    content: string;
    structuredContent?: unknown;
  } = {
    role: "function",
    name: functionName,
    content: toolMessageContent
  };
  if (typeof toolResult === "object" && toolResult) {
    message.structuredContent = (toolResult as any).structuredContent;
  }
  return message;
}

function appendBlueprintIfMissing(functionName: string, functionArgs: Record<string, unknown>, blueprint: Blueprint) {
  const needsBlueprint =
    functionName === "validate_blueprint" ||
    functionName === "synthesize_preview" ||
    functionName === "create_song";
  if (!needsBlueprint) return;

  if (!("blueprint" in functionArgs)) {
    functionArgs.blueprint = blueprint;
  }
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

function buildSongPromptFromBlueprint(
  blueprint: Blueprint,
  options?: { forceInstrumental?: boolean; prompt?: string }
): string {
  if (options?.prompt?.trim() && !looksLikeJsonPayload(options.prompt)) {
    return options.prompt.trim();
  }

  const sections = blueprint.sections.map((section) => {
    const bars = typeof section.bars === "number" ? `${section.bars} bars` : "bars unspecified";
    const energy = typeof section.energy === "number" ? `energy ${section.energy}` : "energy flexible";
    return `${section.name || "section"} (${bars}, ${energy})`;
  });
  const details = [
    "Compose a complete song with instrumental production and expressive lead vocals.",
    `Style: ${blueprint.style}.`,
    `Tempo: ${blueprint.tempo_bpm} BPM.`,
    `Key: ${blueprint.key}.`,
    `Time signature: ${blueprint.time_signature || "4/4"}.`,
    sections.length > 0 ? `Sections: ${sections.join(", ")}.` : undefined,
    options?.forceInstrumental ? "Generate an instrumental version with no vocals." : "Include vocals that sing the lyrics.",
    `Lyrics:\n${blueprint.lyrics}`
  ].filter((line): line is string => Boolean(line));
  return details.join("\n\n");
}

function estimateMusicLengthMs(blueprint: Blueprint): number {
  const bpm = blueprint.tempo_bpm || 100;
  const bars = blueprint.sections.reduce((sum, section) => sum + (section.bars || 0), 0) || 32;
  const beatMs = 60000 / bpm;
  const beatsPerBar = 4;
  const length = Math.round(bars * beatsPerBar * beatMs);
  return Math.max(10000, Math.min(length, 300000));
}

function clampMusicLengthMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  return Math.max(10000, Math.min(Math.round(value), 300000));
}

function mapArgsToCreateSong(functionArgs: Record<string, unknown>, blueprint: Blueprint): CreateSongArgs {
  const requestedModelId = typeof functionArgs.model_id === "string" ? functionArgs.model_id.trim() : undefined;
  const normalizedModelId =
    requestedModelId && requestedModelId.toLowerCase().startsWith("music")
      ? requestedModelId
      : undefined;

  return {
    blueprint,
    prompt:
      typeof functionArgs.prompt === "string"
        ? buildSongPromptFromBlueprint(blueprint, { prompt: functionArgs.prompt })
        : buildSongPromptFromBlueprint(blueprint),
    model_id: normalizedModelId,
    music_length_ms: clampMusicLengthMs(
      typeof functionArgs.music_length_ms === "number"
        ? functionArgs.music_length_ms
        : estimateMusicLengthMs(blueprint)
    ),
    force_instrumental:
      typeof functionArgs.force_instrumental === "boolean" ? functionArgs.force_instrumental : false,
    output_format: typeof functionArgs.output_format === "string" ? functionArgs.output_format : undefined
  };
}

async function run() {
  const openAiKey = assertEnv("OPENAI_API_KEY");
  const tunnelUrl = assertEnv("MCP_TUNNEL_URL");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const blueprint = loadBlueprint();
  const blueprintSummary = JSON.stringify(blueprint, null, 2);
  const prompt = process.argv.slice(2).join(" ") || "Please validate the blueprint below and synthesize a short preview.";
  const promptRequestsSong = /\b(song|track|full song)\b/i.test(prompt);
  const openai = new OpenAI({ apiKey: openAiKey });
  const client = new Client({ name: "gpt-bridge", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(tunnelUrl));
  await client.connect(transport);

  try {
    const systemInstruction = "You are a tool broker that uses MCP to validate blueprints, synthesize previews, and create songs via ElevenLabs.";
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: `${prompt}\n\nBlueprint:\n${blueprintSummary}` }
      ],
      functions: functions as any,
      function_call: "auto"
    });

    const choice = completion.choices[0];
    if (!choice.message?.function_call) {
      console.log("LLM response:");
      console.log(choice.message?.content ?? "(no content)");
      return;
    }

    const functionCall = choice.message.function_call;
    let functionName = functionCall.name;
    let functionArgs = JSON.parse(functionCall.arguments ?? "{}") as Record<string, unknown>;
    appendBlueprintIfMissing(functionName, functionArgs, blueprint);

    if (promptRequestsSong && functionName !== "validate_blueprint") {
      functionName = "create_song";
      functionArgs = mapArgsToCreateSong(functionArgs, blueprint) as Record<string, unknown>;
    }

    console.log(`Invoking MCP tool ${functionName} with arguments:`, JSON.stringify(functionArgs, null, 2));

    const toolMessage = await executeToolAndStore(
      client,
      functionName,
      functionArgs,
      blueprint
    );

    const followUpMessages = [
      { role: "system", content: systemInstruction },
      { role: "user", content: `${prompt}\n\nBlueprint:\n${blueprintSummary}` },
      toolMessage
    ];

    if (functionName === "validate_blueprint" && toolMessage.structuredContent?.ok) {
      const nextTool = promptRequestsSong ? "create_song" : "synthesize_preview";
      const nextToolArgs = promptRequestsSong
        ? mapArgsToCreateSong({}, blueprint)
        : { blueprint };
      const synthMessage = await executeToolAndStore(
        client,
        nextTool,
        nextToolArgs,
        blueprint
      );
      followUpMessages.push(synthMessage);
    }

    const followUp = await openai.chat.completions.create({
      model,
      messages: followUpMessages
    });

    console.log("LLM final response:");
    console.log(followUp.choices[0].message?.content ?? "(no content)");
  } finally {
    await transport.close();
    await client.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
