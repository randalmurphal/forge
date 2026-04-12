/**
 * Session utility functions for the Codex app-server manager.
 *
 * All functions are pure (no `this`, no class coupling) and operate on plain
 * values. They handle model slug normalization, stderr classification, resume
 * cursor parsing, branded ID construction, CLI version checks, and JSON-RPC
 * method-to-request-kind mapping.
 *
 * @module codexSessionHelpers
 */

import { type ChildProcessWithoutNullStreams, spawnSync } from "node:child_process";

import {
  ProviderItemId,
  ProviderRequestKind,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
  type RuntimeMode,
} from "@forgetools/contracts";
import { normalizeModelSlug } from "@forgetools/shared/model";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "./codexCliVersion";
import { killCodexChildProcess } from "./codexAppServer";
import { readArray, readObject, readString } from "./codexJsonRpc";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CODEX_VERSION_CHECK_TIMEOUT_MS = 4_000;

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
export const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
export const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;
export const BENIGN_ERROR_LOG_SNIPPETS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
];
export const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  "not found",
  "missing thread",
  "no such thread",
  "unknown thread",
  "does not exist",
];

// ---------------------------------------------------------------------------
// User input answer types
// ---------------------------------------------------------------------------

export interface CodexUserInputAnswer {
  answers: string[];
}

// ---------------------------------------------------------------------------
// Model slug normalization
// ---------------------------------------------------------------------------

export function normalizeCodexModelSlug(
  model: string | undefined | null,
  preferredId?: string,
): string | undefined {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return undefined;
  }

  if (preferredId?.endsWith("-codex") && preferredId !== normalized) {
    return preferredId;
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// Stderr classification
// ---------------------------------------------------------------------------

export function classifyCodexStderrLine(rawLine: string): { message: string } | null {
  const line = rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
  if (!line) {
    return null;
  }

  const match = line.match(CODEX_STDERR_LOG_REGEX);
  if (match) {
    const level = match[1];
    if (level && level !== "ERROR") {
      return null;
    }

    const isBenignError = BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet));
    if (isBenignError) {
      return null;
    }
  }

  return { message: line };
}

// ---------------------------------------------------------------------------
// Thread resume error classification
// ---------------------------------------------------------------------------

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("thread/resume")) {
    return false;
  }

  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

// ---------------------------------------------------------------------------
// User input answer serialization
// ---------------------------------------------------------------------------

export function toCodexUserInputAnswer(value: unknown): CodexUserInputAnswer {
  if (typeof value === "string") {
    return { answers: [value] };
  }

  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    return { answers };
  }

  if (value && typeof value === "object") {
    const maybeAnswers = (value as { answers?: unknown }).answers;
    if (Array.isArray(maybeAnswers)) {
      const answers = maybeAnswers.filter((entry): entry is string => typeof entry === "string");
      return { answers };
    }
  }

  throw new Error("User input answers must be strings or arrays of strings.");
}

export function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): Record<string, CodexUserInputAnswer> {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => [
      questionId,
      toCodexUserInputAnswer(value),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Branded ID helpers
// ---------------------------------------------------------------------------

export function brandIfNonEmpty<T extends string>(
  value: string | undefined,
  maker: (value: string) => T,
): T | undefined {
  const normalized = value?.trim();
  return normalized?.length ? maker(normalized) : undefined;
}

export function normalizeProviderThreadId(value: string | undefined): string | undefined {
  return brandIfNonEmpty(value, (normalized) => normalized);
}

export function toTurnId(value: string | undefined): TurnId | undefined {
  return brandIfNonEmpty(value, TurnId.makeUnsafe);
}

export function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return brandIfNonEmpty(value, ProviderItemId.makeUnsafe);
}

// ---------------------------------------------------------------------------
// Resume cursor reading
// ---------------------------------------------------------------------------

export function readResumeCursorThreadId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const rawThreadId = (resumeCursor as Record<string, unknown>).threadId;
  return typeof rawThreadId === "string" ? normalizeProviderThreadId(rawThreadId) : undefined;
}

export function readResumeThreadId(input: {
  readonly resumeCursor?: unknown;
  readonly threadId?: ThreadId;
  readonly runtimeMode?: RuntimeMode;
}): string | undefined {
  return readResumeCursorThreadId(input.resumeCursor);
}

// ---------------------------------------------------------------------------
// JSON-RPC method to request kind mapping
// ---------------------------------------------------------------------------

export function requestKindForMethod(method: string): ProviderRequestKind | undefined {
  if (method === "item/commandExecution/requestApproval") {
    return "command";
  }

  if (method === "item/fileRead/requestApproval") {
    return "file-read";
  }

  if (method === "item/fileChange/requestApproval") {
    return "file-change";
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Session state update (pure — mutates only the context.session reference)
// ---------------------------------------------------------------------------

export function updateSession(
  context: { session: ProviderSession },
  updates: Partial<ProviderSession>,
): void {
  context.session = {
    ...context.session,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Thread snapshot parsing
// ---------------------------------------------------------------------------

export function parseThreadSnapshot(
  method: string,
  response: unknown,
): { threadId: string; turns: Array<{ id: TurnId; items: unknown[] }> } {
  const responseRecord = readObject(response);
  const thread = readObject(responseRecord, "thread");
  const threadIdRaw = readString(thread, "id") ?? readString(responseRecord, "threadId");
  if (!threadIdRaw) {
    throw new Error(`${method} response did not include a thread id.`);
  }
  const turnsRaw = readArray(thread, "turns") ?? readArray(responseRecord, "turns") ?? [];
  const turns = turnsRaw.map((turnValue, index) => {
    const turn = readObject(turnValue);
    const turnIdRaw = readString(turn, "id") ?? `${threadIdRaw}:turn:${index + 1}`;
    const turnId = TurnId.makeUnsafe(turnIdRaw);
    const items = readArray(turn, "items") ?? [];
    return {
      id: turnId,
      items,
    };
  });

  return {
    threadId: threadIdRaw,
    turns,
  };
}

// ---------------------------------------------------------------------------
// Process tree management
// ---------------------------------------------------------------------------

/**
 * On Windows with `shell: true`, `child.kill()` only terminates the `cmd.exe`
 * wrapper, leaving the actual command running. Use `taskkill /T` to kill the
 * entire process tree instead.
 */
export function killChildTree(child: ChildProcessWithoutNullStreams): void {
  killCodexChildProcess(child);
}

// ---------------------------------------------------------------------------
// CLI version assertion
// ---------------------------------------------------------------------------

export function assertSupportedCodexCliVersion(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly homePath?: string;
}): void {
  const result = spawnSync(input.binaryPath, ["--version"], {
    cwd: input.cwd,
    env: {
      ...process.env,
      ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
    },
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CODEX_VERSION_CHECK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    const lower = result.error.message.toLowerCase();
    if (
      lower.includes("enoent") ||
      lower.includes("command not found") ||
      lower.includes("not found")
    ) {
      throw new Error(`Codex CLI (${input.binaryPath}) is not installed or not executable.`);
    }
    throw new Error(
      `Failed to execute Codex CLI version check: ${result.error.message || String(result.error)}`,
    );
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    const detail = stderr.trim() || stdout.trim() || `Command exited with code ${result.status}.`;
    throw new Error(`Codex CLI version check failed. ${detail}`);
  }

  const parsedVersion = parseCodexCliVersion(`${stdout}\n${stderr}`);
  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    throw new Error(formatCodexCliUpgradeMessage(parsedVersion));
  }
}
