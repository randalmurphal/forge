const DEBUG_TRUE_VALUES = new Set(["1", "true"]);

export const DEBUG_BACKGROUND_TASKS = DEBUG_TRUE_VALUES.has(
  String(import.meta.env.FORGE_DEBUG_BACKGROUND_TASKS ?? "")
    .trim()
    .toLowerCase(),
);

if (DEBUG_BACKGROUND_TASKS) {
  console.warn("[forge:bg:web] debug enabled");
}

export function debugBackgroundTasks(label: string, details: unknown): void {
  if (!DEBUG_BACKGROUND_TASKS) {
    return;
  }

  console.warn(`[forge:bg:web] ${label}`, details);
}

export function describeBackgroundDebugError(error: unknown): Record<string, unknown> {
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
