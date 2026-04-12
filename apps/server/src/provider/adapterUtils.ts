/**
 * Shared utility functions used by both the Claude and Codex provider adapters.
 *
 * Keeps error classification and debug logging consistent across adapters
 * without duplicating logic.
 */
import type { ThreadId } from "@forgetools/contracts";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "./Errors.ts";
import { appendServerDebugRecord, isServerDebugEnabled } from "../debug.ts";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/** Extract an error message from an unknown cause, falling back to a default. */
export function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

/**
 * Per-adapter string patterns used to classify an unknown error as a
 * session-not-found or session-closed error. Each adapter intentionally uses
 * different matching strings, so the matchers are parameterized.
 */
export interface SessionErrorMatchers {
  readonly notFoundPatterns: readonly string[];
  readonly closedPatterns: readonly string[];
}

export const CLAUDE_SESSION_ERROR_MATCHERS: SessionErrorMatchers = {
  notFoundPatterns: ["unknown session", "not found"],
  closedPatterns: ["closed"],
};

export const CODEX_SESSION_ERROR_MATCHERS: SessionErrorMatchers = {
  notFoundPatterns: ["unknown session", "unknown provider session"],
  closedPatterns: ["session is closed"],
};

/**
 * Classify an unknown cause as a session-not-found or session-closed error
 * using the supplied adapter-specific matchers. Returns `undefined` when the
 * cause does not match any known session error pattern.
 */
export function toSessionError(
  provider: string,
  threadId: ThreadId,
  cause: unknown,
  matchers: SessionErrorMatchers,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (matchers.notFoundPatterns.some((p) => normalized.includes(p))) {
    return new ProviderAdapterSessionNotFoundError({ provider, threadId, cause });
  }
  if (matchers.closedPatterns.some((p) => normalized.includes(p))) {
    return new ProviderAdapterSessionClosedError({ provider, threadId, cause });
  }
  return undefined;
}

/**
 * Map an unknown cause into a typed `ProviderAdapterError`. Session errors are
 * detected first via `toSessionError`; anything else becomes a generic
 * `ProviderAdapterRequestError`.
 */
export function toRequestError(
  provider: string,
  threadId: ThreadId,
  method: string,
  cause: unknown,
  matchers: SessionErrorMatchers,
): ProviderAdapterError {
  const sessionError = toSessionError(provider, threadId, cause, matchers);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

// ---------------------------------------------------------------------------
// Debug helpers
// ---------------------------------------------------------------------------

export const DEBUG_BACKGROUND_TASKS = isServerDebugEnabled("background");

/** Log a structured background-task debug record if the `background` debug topic is enabled. */
export function logBackgroundDebug(
  source: string,
  label: string,
  details: Record<string, unknown>,
): void {
  if (!DEBUG_BACKGROUND_TASKS) return;
  appendServerDebugRecord({ topic: "background", source, label, details });
}
