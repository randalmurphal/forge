import type { ChannelId, ThreadId } from "@forgetools/contracts";
import type { DynamicToolHandler, DynamicToolSpec } from "../codexAppServerManager.ts";

interface PendingToolConfig {
  tools: DynamicToolSpec[];
  handler: DynamicToolHandler;
}

const pending = new Map<string, PendingToolConfig>();

export function registerPendingDynamicTools(
  threadId: ThreadId,
  tools: DynamicToolSpec[],
  handler: DynamicToolHandler,
): void {
  pending.set(threadId, { tools, handler });
}

export function consumePendingDynamicTools(threadId: string): PendingToolConfig | undefined {
  const config = pending.get(threadId);
  if (config) {
    pending.delete(threadId);
  }
  return config;
}
