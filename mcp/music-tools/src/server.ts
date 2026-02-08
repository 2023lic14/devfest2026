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
import draft2020Schema from "ajv/dist/refs/json-schema-draft-2020-12.json" assert { type: "json" };

dotenv.config();

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

interface Blueprint extends JsonObject {
  lyrics?: string;
  voice?: VoiceSettings;
}

const FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), "tmp/audio-previews");
const DEFAULT_MODEL_ID = process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2";
const LEGACY_SSE_PATH = "/sse";
const LEGACY_SSE_MESSAGES_PATH = "/messages";

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
}) {
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
  const filename = `preview-${Date.now()}-${randomUUID().slice(0, 8)}.mp3`;
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
      voice_id: voiceId,
      model_id: modelId
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
