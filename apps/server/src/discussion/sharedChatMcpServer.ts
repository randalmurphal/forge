import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

type McpTextResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
  readonly isError?: boolean;
};

export interface SharedChatMcpServerInput {
  readonly serverName?: string;
  readonly onPostMessage: (input: { readonly message: string }) => Promise<{
    readonly content: string;
    readonly success: boolean;
  }>;
}

const DEFAULT_SERVER_NAME = "forge-shared-chat";
const SHARED_CHAT_MCP_SUBCOMMAND = "shared-chat-mcp";

function resolveForgeCliEntrypoint(): string {
  const currentEntrypoint = process.argv[1];
  if (currentEntrypoint && existsSync(currentEntrypoint)) {
    return currentEntrypoint;
  }

  const candidates = [
    resolve(import.meta.dirname, "../bin.ts"),
    resolve(import.meta.dirname, "../bin.mjs"),
    resolve(import.meta.dirname, "../bin.js"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Could not resolve the Forge CLI entrypoint for shared chat MCP.");
}

function resolveForgeCliCommand(): {
  readonly command: string;
  readonly args: readonly [string, string];
} {
  return {
    command: process.execPath,
    args: [resolveForgeCliEntrypoint(), SHARED_CHAT_MCP_SUBCOMMAND],
  };
}

function toTextResult(input: {
  readonly content: string;
  readonly success: boolean;
}): McpTextResult {
  return {
    ...(input.success ? {} : { isError: true }),
    content: [
      {
        type: "text",
        text: input.content,
      },
    ],
  };
}

function toErrorTextResult(cause: unknown): McpTextResult {
  const message =
    cause instanceof Error && cause.message.length > 0
      ? cause.message
      : "Shared chat MCP tool failed.";
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: message,
      },
    ],
  };
}

export function makeSharedChatMcpServer(input: SharedChatMcpServerInput) {
  return createSdkMcpServer({
    name: input.serverName ?? DEFAULT_SERVER_NAME,
    version: "1.0.0",
    tools: [
      tool(
        "post_to_chat",
        "Post a message into the shared parent chat.",
        {
          message: z.string().min(1),
        },
        async (args) => {
          try {
            return toTextResult(await input.onPostMessage(args));
          } catch (cause) {
            return toErrorTextResult(cause);
          }
        },
      ),
    ],
  });
}

export function makeSharedChatCodexMcpServerConfig(input: {
  readonly bridgeUrl: string;
  readonly bridgeToken: string;
  readonly bridgeAuthToken?: string;
  readonly serverName?: string;
}) {
  const serverName = input.serverName ?? DEFAULT_SERVER_NAME;
  const command = resolveForgeCliCommand();

  return {
    command: command.command,
    args: [...command.args],
    env: {
      FORGE_SHARED_CHAT_BRIDGE_URL: input.bridgeUrl,
      FORGE_SHARED_CHAT_BRIDGE_TOKEN: input.bridgeToken,
      FORGE_SHARED_CHAT_SERVER_NAME: serverName,
      ...(input.bridgeAuthToken === undefined
        ? {}
        : { FORGE_SHARED_CHAT_BRIDGE_AUTH_TOKEN: input.bridgeAuthToken }),
    },
    tools: {
      post_to_chat: {
        approval_mode: "prompt",
      },
    },
  } as const;
}
