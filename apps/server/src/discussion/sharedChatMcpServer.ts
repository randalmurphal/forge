import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

import { resolveForgeCliCommand } from "../mcp/cliEntrypoint.ts";
import { catchToErrorResult, textResult } from "../mcp/mcpHelpers.ts";

export interface SharedChatMcpServerInput {
  readonly serverName?: string;
  readonly onPostMessage: (input: { readonly message: string }) => Promise<{
    readonly content: string;
    readonly success: boolean;
  }>;
}

const DEFAULT_SERVER_NAME = "forge-shared-chat";
const SHARED_CHAT_MCP_SUBCOMMAND = "shared-chat-mcp";

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
            return textResult(await input.onPostMessage(args));
          } catch (cause) {
            return catchToErrorResult(cause, "Shared chat MCP tool failed.");
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
  const command = resolveForgeCliCommand(SHARED_CHAT_MCP_SUBCOMMAND);

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
