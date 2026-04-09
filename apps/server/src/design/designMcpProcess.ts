import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

const BRIDGE_URL_ENV = "FORGE_DESIGN_BRIDGE_URL";
const BRIDGE_TOKEN_ENV = "FORGE_DESIGN_BRIDGE_TOKEN";
const BRIDGE_AUTH_TOKEN_ENV = "FORGE_DESIGN_BRIDGE_AUTH_TOKEN";
const SERVER_NAME_ENV = "FORGE_DESIGN_SERVER_NAME";
const BRIDGE_TIMEOUT_MS = 30_000;

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}.`);
  }
  return value;
}

function toBridgeError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

async function callDesignBridge(input: {
  readonly bridgeUrl: string;
  readonly bridgeToken: string;
  readonly bridgeAuthToken: string | undefined;
  readonly action: unknown;
}): Promise<string> {
  const response = await fetch(input.bridgeUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(input.bridgeAuthToken ? { authorization: `Bearer ${input.bridgeAuthToken}` } : {}),
    },
    signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    body: JSON.stringify({
      token: input.bridgeToken,
      action: input.action,
    }),
  });

  if (!response.ok) {
    throw new Error(`Design bridge returned HTTP ${response.status}.`);
  }

  const payload = (await response.json().catch(() => null)) as { result?: string } | null;
  if (payload && typeof payload.result === "string") {
    return payload.result;
  }

  throw new Error("Design bridge returned an unrecognized response.");
}

export async function runDesignMcpProcess(): Promise<void> {
  const bridgeUrl = getRequiredEnv(BRIDGE_URL_ENV);
  const bridgeToken = getRequiredEnv(BRIDGE_TOKEN_ENV);
  const bridgeAuthToken = process.env[BRIDGE_AUTH_TOKEN_ENV]?.trim() || undefined;
  const serverName = process.env[SERVER_NAME_ENV]?.trim() || "forge-design";

  const server = new McpServer({
    name: serverName,
    version: "1.0.0",
  });

  server.registerTool(
    "render_design",
    {
      description:
        "Render a complete, self-contained HTML/CSS/JS design mockup in the user's preview panel. The HTML must be a full document with <!DOCTYPE html>, <html>, <head>, and <body> tags. Include all CSS inline or via CDN links. Include all JavaScript inline or via CDN script tags. The document must be viewable standalone in a browser.",
      inputSchema: {
        html: z.string().min(1).describe("Complete self-contained HTML document"),
        title: z.string().min(1).describe("Short descriptive title for this design"),
        description: z.string().optional().describe("Design rationale and what this represents"),
      },
    },
    async (args) => {
      try {
        const result = await callDesignBridge({
          bridgeUrl,
          bridgeToken,
          bridgeAuthToken,
          action: {
            action: "render_design",
            html: args.html,
            title: args.title,
            description: args.description,
          },
        });
        return {
          content: [{ type: "text" as const, text: result }],
        };
      } catch (cause) {
        const error = toBridgeError(cause);
        return {
          isError: true,
          content: [{ type: "text" as const, text: error.message }],
        };
      }
    },
  );

  server.registerTool(
    "present_options",
    {
      description:
        "Present multiple design options for the user to choose between. Each option is a complete HTML document rendered in the preview panel. The tool call will block until the user makes a selection. Use this when the design direction is unclear and you want the user to pick between distinct approaches.",
      inputSchema: {
        prompt: z.string().min(1).describe("What you're asking the user to decide"),
        options: z
          .array(
            z.object({
              id: z.string().min(1).describe("Short identifier like 'a', 'b', 'c'"),
              title: z.string().min(1).describe("Option name, e.g. 'Minimal & Clean'"),
              description: z.string().min(1).describe("What makes this option distinct"),
              html: z
                .string()
                .min(1)
                .describe("Complete self-contained HTML document for this option"),
            }),
          )
          .min(2)
          .describe("At least 2 design options"),
      },
    },
    async (args) => {
      try {
        const result = await callDesignBridge({
          bridgeUrl,
          bridgeToken,
          bridgeAuthToken,
          action: {
            action: "present_options",
            prompt: args.prompt,
            options: args.options,
          },
        });
        return {
          content: [{ type: "text" as const, text: result }],
        };
      } catch (cause) {
        const error = toBridgeError(cause);
        return {
          isError: true,
          content: [{ type: "text" as const, text: error.message }],
        };
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
