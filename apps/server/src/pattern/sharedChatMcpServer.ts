import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

type McpTextResult = {
  readonly content: ReadonlyArray<{
    readonly type: "text";
    readonly text: string;
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
