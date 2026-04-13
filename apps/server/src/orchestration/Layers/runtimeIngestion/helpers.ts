import {
  ApprovalRequestId,
  CommandId,
  type OrchestrationEvent,
  type OrchestrationToolInlineDiff,
  type ThreadTokenUsageSnapshot,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@forgetools/contracts";
import { Duration } from "effect";
import { asRecord, asTrimmedString, truncateDetail } from "@forgetools/shared/narrowing";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../../checkpointing/Diffs.ts";

export type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

export type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    };

export type PendingCommandInlineDiff = {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly itemId: string;
  readonly normalizedCommand: string;
  readonly inlineDiff: OrchestrationToolInlineDiff;
};

export const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
export const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
export const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
export const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
export const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
export const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
export const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
export const STRICT_PROVIDER_LIFECYCLE_GUARD =
  process.env.FORGE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

export const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
export const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${crypto.randomUUID()}`);

export function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.makeUnsafe(String(value));
}

export function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.makeUnsafe(value);
}

export function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

export function normalizeProposedPlanMarkdown(
  planMarkdown: string | undefined,
): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

export function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

export function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

export function mergeDiffFilesByPath(
  files: ReadonlyArray<{
    path: string;
    kind: string;
    additions: number;
    deletions: number;
  }>,
) {
  const merged = new Map<
    string,
    {
      path: string;
      kind: string;
      additions: number;
      deletions: number;
    }
  >();

  for (const file of files) {
    const existing = merged.get(file.path);
    if (existing) {
      merged.set(file.path, {
        ...existing,
        additions: existing.additions + file.additions,
        deletions: existing.deletions + file.deletions,
      });
      continue;
    }
    merged.set(file.path, file);
  }

  return Array.from(merged.values()).toSorted((left, right) => left.path.localeCompare(right.path));
}

export function mapUnifiedDiffToCheckpointFiles(diff: string) {
  return mergeDiffFilesByPath(
    parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
      path: file.path,
      kind: "modified",
      additions: file.additions,
      deletions: file.deletions,
    })),
  );
}

export function extractBackgroundDebugItemRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const directItem = asRecord(record.item);
  if (directItem) {
    return directItem;
  }

  const nestedData = asRecord(record.data);
  const nestedItem = asRecord(nestedData?.item);
  if (nestedItem) {
    return nestedItem;
  }

  return record;
}

export function extractBackgroundDebugSource(value: unknown): string | undefined {
  const item = extractBackgroundDebugItemRecord(value);
  return asTrimmedString(item?.source);
}

export function extractBackgroundDebugProcessId(value: unknown): string | undefined {
  const record = asRecord(value);
  const item = extractBackgroundDebugItemRecord(value);
  return asTrimmedString(record?.processId) ?? asTrimmedString(item?.processId);
}

export function extractBackgroundDebugCommandPreview(value: unknown): string | undefined {
  const command = extractRuntimeToolCommand(value);
  if (!command) {
    return undefined;
  }

  return truncateDetail(command, 140);
}

export function extractBackgroundDebugChildThread(value: unknown):
  | {
      taskId?: string | undefined;
      childProviderThreadId?: string | undefined;
    }
  | undefined {
  const record = asRecord(value);
  const child = asRecord(record?.childThreadAttribution);
  if (!child) {
    return undefined;
  }
  const taskId = asTrimmedString(child.taskId);
  const childProviderThreadId = asTrimmedString(child.childProviderThreadId);
  if (!taskId && !childProviderThreadId) {
    return undefined;
  }
  return {
    ...(taskId ? { taskId } : {}),
    ...(childProviderThreadId ? { childProviderThreadId } : {}),
  };
}

export function quoteShellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function normalizeCommandValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return parts.length > 0 ? parts.map((entry) => quoteShellArgument(entry)).join(" ") : undefined;
}

export function extractRuntimeToolCommand(data: unknown): string | undefined {
  const payload = asRecord(data);
  const item = asRecord(payload?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(payload?.command),
  ];
  return candidates.find((candidate) => candidate !== undefined);
}

export function extractRuntimeCommandExitCode(data: unknown): number | undefined {
  const payload = asRecord(data);
  const item = asRecord(payload?.item);
  const itemResult = asRecord(item?.result);
  const candidates = [
    item?.exitCode,
    payload?.exitCode,
    itemResult?.exitCode,
    itemResult?.exit_code,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function hasDependentShellMutationPaths(
  operations: ReadonlyArray<
    | {
        readonly kind: "delete";
        readonly path: string;
      }
    | {
        readonly kind: "rename";
        readonly oldPath: string;
        readonly newPath: string;
      }
  >,
): boolean {
  const touchedPaths = new Set<string>();
  for (const operation of operations) {
    const paths =
      operation.kind === "delete" ? [operation.path] : [operation.oldPath, operation.newPath];
    if (paths.some((entry) => touchedPaths.has(entry))) {
      return true;
    }
    for (const entry of paths) {
      touchedPaths.add(entry);
    }
  }
  return false;
}

export function pathsOverlap(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  const rightPaths = new Set(right);
  return left.some((path) => rightPaths.has(path));
}

export function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ThreadTokenUsageSnapshot | undefined {
  if (event.type !== "thread.token-usage.updated" || event.payload.usage.usedTokens <= 0) {
    return undefined;
  }
  return event.payload.usage;
}

export function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

export function orchestrationSessionStatusFromRuntimeState(
  state:
    | "starting"
    | "running"
    | "waiting"
    | "ready"
    | "idle"
    | "interrupted"
    | "stopped"
    | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
    case "idle":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

export function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return undefined;
  }
}

export function isApprovalRequestType(requestType: string | undefined): boolean {
  return requestKindFromCanonicalRequestType(requestType) !== undefined;
}

export function extractChildThreadAttribution(
  eventPayload: unknown,
): Record<string, unknown> | undefined {
  if (!eventPayload || typeof eventPayload !== "object") return undefined;
  const payload = eventPayload as Record<string, unknown>;
  const attr = payload.childThreadAttribution;
  if (!attr || typeof attr !== "object") return undefined;
  return attr as Record<string, unknown>;
}

export const pendingCommandInlineDiffKey = (threadId: ThreadId, itemId: string) =>
  `${threadId}:${itemId}`;
