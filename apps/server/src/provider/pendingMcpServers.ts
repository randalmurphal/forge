export type PendingMcpServerConfig = {
  readonly config: Record<string, unknown>;
};

const pendingMcpServers = new Map<string, PendingMcpServerConfig>();

export function registerPendingMcpServer(
  threadId: string,
  mcpConfig: PendingMcpServerConfig,
): void {
  pendingMcpServers.set(threadId, mcpConfig);
}

export function getPendingMcpServer(threadId: string): PendingMcpServerConfig | undefined {
  return pendingMcpServers.get(threadId);
}
