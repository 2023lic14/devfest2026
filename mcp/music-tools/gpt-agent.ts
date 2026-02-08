import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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
  sections: { name: string; bars: number; energy?: number }[];
  lyrics: string;
  voice: { voice_id: string };
};

const defaultBlueprint: Blueprint = {
  id: "demo-blueprint",
  style: "dreamy pop",
  tempo_bpm: 110,
  key: "C",
  sections: [{ name: "verse", bars: 8, energy: 0.6 }, { name: "chorus", bars: 8, energy: 0.8 }],
  lyrics: "This is just a test of the music tools, validating and previewing a simple idea.",
  voice: { voice_id: process.env.ELEVENLABS_DEFAULT_VOICE_ID ?? "21m00T1W" }
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

async function callTool(client: Client, functionName: string, args: Record<string, unknown>) {
  const toolArguments: Record<string, unknown> = { ...args };

  const result = await client.callTool({ name: functionName, arguments: toolArguments });
  return result;
}

function appendBlueprintIfMissing(functionName: string, functionArgs: Record<string, unknown>, blueprint: Blueprint) {
  const needsBlueprint = functionName === "validate_blueprint" || functionName === "synthesize_preview";
  if (!needsBlueprint) return;

  if (!("blueprint" in functionArgs)) {
    functionArgs.blueprint = blueprint;
  }
}

async function run() {
  const openAiKey = assertEnv("OPENAI_API_KEY");
  const tunnelUrl = assertEnv("MCP_TUNNEL_URL");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const blueprint = loadBlueprint();
  const blueprintSummary = JSON.stringify(blueprint, null, 2);
  const prompt = process.argv.slice(2).join(" ") || "Please validate the blueprint below and synthesize a short preview.";
  const openai = new OpenAI({ apiKey: openAiKey });
  const client = new Client({ name: "gpt-bridge", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(tunnelUrl));
  await client.connect(transport);

  try {
    const systemInstruction = "You are a tool broker that uses MCP to validate blueprints and synthesize previews via ElevenLabs.";
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
    const functionName = functionCall.name;
    const functionArgs = JSON.parse(functionCall.arguments ?? "{}");
    appendBlueprintIfMissing(functionName, functionArgs, blueprint);

    console.log(`Invoking MCP tool ${functionName} with arguments:`, JSON.stringify(functionArgs, null, 2));

    const toolResult = await callTool(client, functionName, functionArgs);
    const toolMessage = {
      role: "function",
      name: functionName,
      content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult, null, 2)
    };

    const followUp = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: `${prompt}\n\nBlueprint:\n${blueprintSummary}` },
        toolMessage
      ]
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
