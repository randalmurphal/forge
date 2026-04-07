import type { ThreadId } from "@forgetools/contracts";
import type { DynamicToolHandler, DynamicToolSpec } from "../codexAppServerManager.ts";

interface PendingSessionConfig {
  tools: DynamicToolSpec[];
  handler: DynamicToolHandler;
  baseInstructions?: string;
}

const pending = new Map<string, PendingSessionConfig>();

export function registerPendingSessionConfig(
  threadId: ThreadId,
  config: PendingSessionConfig,
): void {
  pending.set(threadId, config);
}

export function consumePendingSessionConfig(threadId: string): PendingSessionConfig | undefined {
  const config = pending.get(threadId);
  if (config) {
    pending.delete(threadId);
  }
  return config;
}
