export type McpTextResult = {
  content: Array<{ type: "text"; text: string }>;
  readonly isError?: boolean;
};

export function textResult(input: { content: string; success: boolean }): McpTextResult {
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

export function errorResult(message: string): McpTextResult {
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

export function stringifyResult(payload: unknown): McpTextResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload),
      },
    ],
  };
}

export function toErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

export function catchToErrorResult(cause: unknown, fallback?: string): McpTextResult {
  return errorResult(toErrorMessage(cause, fallback ?? "MCP tool failed."));
}
