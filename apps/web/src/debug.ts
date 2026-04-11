import { isDebugTopicEnabled, parseDebugTopics, type DebugConfig } from "@forgetools/shared/debug";

export type WebDebugTopic = string;

export function resolveWebDebugConfig(env: { readonly FORGE_DEBUG?: string }): DebugConfig {
  return parseDebugTopics(env.FORGE_DEBUG);
}

export const WEB_DEBUG_CONFIG: DebugConfig = resolveWebDebugConfig({
  FORGE_DEBUG: import.meta.env.FORGE_DEBUG,
});

if (WEB_DEBUG_CONFIG.enabled) {
  console.warn("[forge:web] debug enabled", {
    all: WEB_DEBUG_CONFIG.all,
    topics: Array.from(WEB_DEBUG_CONFIG.topics),
  });
}

export function isWebDebugEnabled(topic: WebDebugTopic): boolean {
  return isDebugTopicEnabled(WEB_DEBUG_CONFIG, topic);
}

export function debugLog(input: {
  readonly topic: WebDebugTopic;
  readonly source: string;
  readonly label: string;
  readonly details: unknown;
}): void {
  if (!isWebDebugEnabled(input.topic)) {
    return;
  }

  console.warn(`[forge:${input.topic}:${input.source}] ${input.label}`, input.details);
}

export function describeWebDebugError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }

  return {
    value: String(error),
  };
}
