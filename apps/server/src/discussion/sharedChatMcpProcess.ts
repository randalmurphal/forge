import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

const BRIDGE_URL_ENV = "FORGE_SHARED_CHAT_BRIDGE_URL";
const BRIDGE_TOKEN_ENV = "FORGE_SHARED_CHAT_BRIDGE_TOKEN";
const BRIDGE_AUTH_TOKEN_ENV = "FORGE_SHARED_CHAT_BRIDGE_AUTH_TOKEN";
const SERVER_NAME_ENV = "FORGE_SHARED_CHAT_SERVER_NAME";
const BRIDGE_TIMEOUT_MS = 15_000;

type SharedChatBridgeResponse = {
  readonly content: string;
  readonly success: boolean;
};

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

async function postToSharedChat(input: {
  readonly bridgeUrl: string;
  readonly bridgeToken: string;
  readonly bridgeAuthToken: string | undefined;
  readonly message: string;
}): Promise<SharedChatBridgeResponse> {
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
      message: input.message,
    }),
  });

  const payload = (await response.json().catch(() => null)) as SharedChatBridgeResponse | null;
  if (payload && typeof payload.content === "string" && typeof payload.success === "boolean") {
    return payload;
  }

  throw new Error(`Shared chat bridge returned HTTP ${response.status}.`);
}

export async function runSharedChatMcpProcess(): Promise<void> {
  const bridgeUrl = getRequiredEnv(BRIDGE_URL_ENV);
  const bridgeToken = getRequiredEnv(BRIDGE_TOKEN_ENV);
  const bridgeAuthToken = process.env[BRIDGE_AUTH_TOKEN_ENV]?.trim() || undefined;
  const serverName = process.env[SERVER_NAME_ENV]?.trim() || "forge-shared-chat";

  const server = new McpServer({
    name: serverName,
    version: "1.0.0",
  });

  server.registerTool(
    "post_to_chat",
    {
      description: "Post a message into the shared parent chat.",
      inputSchema: {
        message: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const result = await postToSharedChat({
          bridgeUrl,
          bridgeToken,
          bridgeAuthToken,
          message: args.message,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: result.content,
            },
          ],
          ...(result.success ? {} : { isError: true }),
        };
      } catch (cause) {
        const error = toBridgeError(cause);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: error.message,
            },
          ],
        };
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
