import type { ThreadId } from "@forgetools/contracts";

import type { DynamicToolHandler, DynamicToolSpec } from "../codexAppServerManager.ts";

interface PendingSessionToolConfig {
  readonly tools: DynamicToolSpec[];
  readonly handler: DynamicToolHandler;
}

const pending = new Map<string, PendingSessionToolConfig>();

export function registerPendingSessionTools(
  threadId: ThreadId,
  config: PendingSessionToolConfig,
): void {
  pending.set(threadId, config);
}

export function getPendingSessionTools(threadId: string): PendingSessionToolConfig | undefined {
  return pending.get(threadId);
}
