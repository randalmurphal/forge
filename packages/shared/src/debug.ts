const DEBUG_ALL_VALUES = new Set(["*", "all"]);

export interface DebugConfig {
  readonly enabled: boolean;
  readonly all: boolean;
  readonly topics: ReadonlySet<string>;
}

export function normalizeDebugTopic(value: string): string {
  return value.trim().toLowerCase();
}

export function parseDebugTopics(value: string | undefined | null): DebugConfig {
  const normalizedTopics = new Set<string>();

  for (const rawToken of value?.split(/[,\s]+/) ?? []) {
    const token = normalizeDebugTopic(rawToken);
    if (token.length === 0) {
      continue;
    }
    if (DEBUG_ALL_VALUES.has(token)) {
      return {
        enabled: true,
        all: true,
        topics: new Set(),
      };
    }
    normalizedTopics.add(token);
  }

  return {
    enabled: normalizedTopics.size > 0,
    all: false,
    topics: normalizedTopics,
  };
}

export function isDebugTopicEnabled(config: DebugConfig, topic: string): boolean {
  return config.all || config.topics.has(normalizeDebugTopic(topic));
}
