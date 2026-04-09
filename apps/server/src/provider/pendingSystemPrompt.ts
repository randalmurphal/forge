const pending = new Map<string, string>();

export function registerPendingSystemPrompt(threadId: string, systemPrompt: string): void {
  pending.set(threadId, systemPrompt);
}

export function getPendingSystemPrompt(threadId: string): string | undefined {
  return pending.get(threadId);
}
