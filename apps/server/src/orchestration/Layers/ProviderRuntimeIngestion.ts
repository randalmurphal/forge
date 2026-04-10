import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationProposedPlanId,
  CheckpointRef,
  isToolLifecycleItemType,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
} from "@forgetools/contracts";
import { Cache, Cause, Duration, Effect, Layer, Option, Stream } from "effect";
import { makeDrainableWorker } from "@forgetools/shared/DrainableWorker";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionAgentDiffRepositoryLive } from "../../persistence/Layers/ProjectionAgentDiffs.ts";
import { ProjectionAgentDiffRepository } from "../../persistence/Services/ProjectionAgentDiffs.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { buildToolInlineDiffArtifact } from "../toolDiffArtifacts.ts";
import { classifyToolDiffPaths, filterUnifiedDiffByPaths } from "../toolDiffPaths.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${crypto.randomUUID()}`);

const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.FORGE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    };

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.makeUnsafe(String(value));
}

function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.makeUnsafe(value);
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function normalizeProposedPlanMarkdown(planMarkdown: string | undefined): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

function mergeDiffFilesByPath(
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

function mapUnifiedDiffToCheckpointFiles(diff: string) {
  return mergeDiffFilesByPath(
    parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
      path: file.path,
      kind: "modified",
      additions: file.additions,
      deletions: file.deletions,
    })),
  );
}

function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ThreadTokenUsageSnapshot | undefined {
  if (event.type !== "thread.token-usage.updated" || event.payload.usage.usedTokens <= 0) {
    return undefined;
  }
  return event.payload.usage;
}

function normalizeRuntimeTurnState(
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

function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

function requestKindFromCanonicalRequestType(
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

function isApprovalRequestType(requestType: string | undefined): boolean {
  return requestKindFromCanonicalRequestType(requestType) !== undefined;
}

function extractChildThreadAttribution(eventPayload: unknown): Record<string, unknown> | undefined {
  if (!eventPayload || typeof eventPayload !== "object") return undefined;
  const payload = eventPayload as Record<string, unknown>;
  const attr = payload.childThreadAttribution;
  if (!attr || typeof attr !== "object") return undefined;
  return attr as Record<string, unknown>;
}

function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();
  switch (event.type) {
    case "request.opened": {
      if (!isApprovalRequestType(event.payload.requestType)) {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            requestKind === "command"
              ? "Command approval requested"
              : requestKind === "file-read"
                ? "File-read approval requested"
                : requestKind === "file-change"
                  ? "File-change approval requested"
                  : "Approval requested",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.resolved": {
      if (!isApprovalRequestType(event.payload.requestType)) {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(event.payload.message),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          summary: "Runtime warning",
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.plan.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      const taskStartedChildAttr = extractChildThreadAttribution(event.payload);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...(taskStartedChildAttr ? { childThreadAttribution: taskStartedChildAttr } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      const taskProgressChildAttr = extractChildThreadAttribution(event.payload);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            taskId: event.payload.taskId,
            detail: truncateDetail(event.payload.summary ?? event.payload.description),
            ...(event.payload.summary ? { summary: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...(taskProgressChildAttr ? { childThreadAttribution: taskProgressChildAttr } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      const taskCompletedChildAttr = extractChildThreadAttribution(event.payload);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(event.payload.summary ? { detail: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...(taskCompletedChildAttr ? { childThreadAttribution: taskCompletedChildAttr } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary: "Context compacted",
          payload: {
            state: event.payload.state,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.token-usage.updated": {
      const payload = buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.progress": {
      // Access payload fields safely - the schema is being updated by another agent
      // but the payload will have: toolUseId?, toolName?, message?, elapsedSeconds?
      const payload = event.payload as Record<string, unknown>;
      const message = typeof payload.message === "string" ? payload.message : undefined;
      const toolName = typeof payload.toolName === "string" ? payload.toolName : undefined;
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool" as const,
          kind: "tool.progress",
          summary: message ?? (toolName ? `${toolName} in progress` : "Tool in progress"),
          payload: {
            ...(typeof payload.toolUseId === "string" ? { toolCallId: payload.toolUseId } : {}),
            ...(toolName ? { toolName } : {}),
            ...(message ? { detail: truncateDetail(message) } : {}),
            ...(typeof payload.elapsedSeconds === "number"
              ? { elapsedSeconds: payload.elapsedSeconds }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.summary": {
      const payload = event.payload as Record<string, unknown>;
      const summary = typeof payload.summary === "string" ? payload.summary : undefined;
      if (!summary) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool" as const,
          kind: "tool.summary",
          summary,
          payload: {
            summary,
            ...(Array.isArray(payload.toolUseIds) ? { toolUseIds: payload.toolUseIds } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      const inlineDiff =
        event.payload.itemType === "file_change"
          ? buildToolInlineDiffArtifact(event.payload.data)
          : undefined;
      const itemUpdatedToolName = (event.payload as Record<string, unknown>).toolName;
      const itemUpdatedChildAttr = extractChildThreadAttribution(event.payload);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: {
            itemType: event.payload.itemType,
            ...(event.itemId ? { itemId: event.itemId } : {}),
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
            ...(inlineDiff ? { inlineDiff } : {}),
            ...(typeof itemUpdatedToolName === "string" ? { toolName: itemUpdatedToolName } : {}),
            ...(itemUpdatedChildAttr ? { childThreadAttribution: itemUpdatedChildAttr } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.completed": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      const inlineDiff =
        event.payload.itemType === "file_change"
          ? buildToolInlineDiffArtifact(event.payload.data)
          : undefined;
      const itemCompletedToolName = (event.payload as Record<string, unknown>).toolName;
      const itemCompletedChildAttr = extractChildThreadAttribution(event.payload);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: event.payload.title ?? "Tool",
          payload: {
            itemType: event.payload.itemType,
            ...(event.itemId ? { itemId: event.itemId } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
            ...(inlineDiff ? { inlineDiff } : {}),
            ...(typeof itemCompletedToolName === "string"
              ? { toolName: itemCompletedToolName }
              : {}),
            ...(itemCompletedChildAttr ? { childThreadAttribution: itemCompletedChildAttr } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.started": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      const itemStartedToolName = (event.payload as Record<string, unknown>).toolName;
      const itemStartedChildAttr = extractChildThreadAttribution(event.payload);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.itemId ? { itemId: event.itemId } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(typeof itemStartedToolName === "string" ? { toolName: itemStartedToolName } : {}),
            ...(itemStartedChildAttr ? { childThreadAttribution: itemStartedChildAttr } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  return [];
}

const make = Effect.fn("make")(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore;
  const projectionAgentDiffRepository = yield* ProjectionAgentDiffRepository;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const serverSettingsService = yield* ServerSettingsService;

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  const isGitRepoForThread = Effect.fn("isGitRepoForThread")(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return false;
    }
    const workspaceCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    if (!workspaceCwd) {
      return false;
    }
    return isGitRepository(workspaceCwd);
  });

  const resolveWorkspaceCwdForThread = Effect.fn("resolveWorkspaceCwdForThread")(function* (
    threadId: ThreadId,
  ) {
    const [readModel, sessions] = yield* Effect.all([
      orchestrationEngine.getReadModel(),
      providerService.listSessions(),
    ]);
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return undefined;
    }

    const sessionCwd = sessions.find((entry) => entry.threadId === threadId)?.cwd;
    return sessionCwd ?? resolveThreadWorkspaceCwd({ thread, projects: readModel.projects });
  });

  const refreshTurnAgentDiffFromToolArtifact = Effect.fn("refreshTurnAgentDiffFromToolArtifact")(
    function* (input: {
      readonly event: ProviderRuntimeEvent;
      readonly thread: {
        readonly id: ThreadId;
        readonly checkpoints: ReadonlyArray<{
          readonly turnId: TurnId;
          readonly checkpointTurnCount: number;
        }>;
      };
      readonly inlineDiff: NonNullable<ReturnType<typeof buildToolInlineDiffArtifact>>;
    }) {
      const turnId = toTurnId(input.event.turnId);
      if (!turnId) {
        return;
      }

      const workspaceCwd = yield* resolveWorkspaceCwdForThread(input.thread.id);
      if (!workspaceCwd) {
        return;
      }

      const currentRepoFiles = input.inlineDiff.files.flatMap((file) => {
        const repoRelativePath = classifyToolDiffPaths({
          workspaceRoot: workspaceCwd,
          filePaths: [file.path],
          ...(process.env.WSL_DISTRO_NAME ? { wslDistroName: process.env.WSL_DISTRO_NAME } : {}),
        }).repoRelativePaths[0];

        return repoRelativePath
          ? [
              {
                path: repoRelativePath,
                kind: file.kind ?? "modified",
                additions: file.additions ?? 0,
                deletions: file.deletions ?? 0,
              },
            ]
          : [];
      });
      const currentToolPaths = currentRepoFiles.map((file) => file.path);

      const existingDiffOption = yield* projectionAgentDiffRepository
        .getByTurnId({
          threadId: input.thread.id,
          turnId,
        })
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));

      const existingRepoPaths = Option.match(existingDiffOption, {
        onNone: () => [] as string[],
        onSome: (row) =>
          row.source === "derived_tool_results"
            ? classifyToolDiffPaths({
                workspaceRoot: workspaceCwd,
                filePaths: row.files.map((file) => file.path),
                ...(process.env.WSL_DISTRO_NAME
                  ? { wslDistroName: process.env.WSL_DISTRO_NAME }
                  : {}),
              }).repoRelativePaths
            : [],
      });
      const mergedRepoPaths = [...new Set([...existingRepoPaths, ...currentToolPaths])].toSorted();
      if (mergedRepoPaths.length === 0) {
        return;
      }

      const assistantMessageIds = yield* getAssistantMessageIdsForTurn(input.thread.id, turnId);
      const assistantMessageId =
        [...assistantMessageIds].at(-1) ??
        Option.match(existingDiffOption, {
          onNone: () => undefined,
          onSome: (row) => row.assistantMessageId ?? undefined,
        });

      const currentTurnCheckpoint = input.thread.checkpoints
        .filter((checkpoint) => sameId(checkpoint.turnId, turnId))
        .toSorted((left, right) => right.checkpointTurnCount - left.checkpointTurnCount)[0];
      const baselineTurnCount = currentTurnCheckpoint
        ? Math.max(0, currentTurnCheckpoint.checkpointTurnCount - 1)
        : input.thread.checkpoints.reduce(
            (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
            0,
          );
      const baselineCheckpointRef = checkpointRefForThreadTurn(input.thread.id, baselineTurnCount);
      const baselineExists = yield* checkpointStore
        .hasCheckpointRef({
          cwd: workspaceCwd,
          checkpointRef: baselineCheckpointRef,
        })
        .pipe(Effect.catch(() => Effect.succeed(false)));

      const partialFiles = mergeDiffFilesByPath([
        ...Option.match(existingDiffOption, {
          onNone: () => [],
          onSome: (row) => (row.source === "derived_tool_results" ? row.files : []),
        }),
        ...currentRepoFiles,
      ]).filter((file) => mergedRepoPaths.includes(file.path));

      if (baselineExists) {
        const recomputedDiff = yield* checkpointStore
          .diffCheckpointToWorkspace({
            cwd: workspaceCwd,
            checkpointRef: baselineCheckpointRef,
            paths: mergedRepoPaths,
          })
          .pipe(Effect.catch(() => Effect.succeed<string | null>(null)));

        if (recomputedDiff !== null) {
          yield* orchestrationEngine.dispatch({
            type: "thread.agent-diff.upsert",
            commandId: providerCommandId(input.event, "thread-agent-diff-upsert-tool"),
            threadId: input.thread.id,
            turnId,
            diff: recomputedDiff,
            files: mapUnifiedDiffToCheckpointFiles(recomputedDiff),
            source: "derived_tool_results",
            coverage: "complete",
            ...(assistantMessageId ? { assistantMessageId } : {}),
            completedAt: input.event.createdAt,
            createdAt: input.event.createdAt,
          });
          return;
        }
      }

      const filteredInlinePatch = filterUnifiedDiffByPaths({
        diff: input.inlineDiff.unifiedDiff,
        allowedPaths: currentToolPaths,
        workspaceRoot: workspaceCwd,
        ...(process.env.WSL_DISTRO_NAME ? { wslDistroName: process.env.WSL_DISTRO_NAME } : {}),
      });
      const fallbackDiff =
        filteredInlinePatch ??
        Option.match(existingDiffOption, {
          onNone: () => undefined,
          onSome: (row) => (row.source === "derived_tool_results" ? row.diff : undefined),
        });

      yield* orchestrationEngine.dispatch({
        type: "thread.agent-diff.upsert",
        commandId: providerCommandId(input.event, "thread-agent-diff-upsert-tool-partial"),
        threadId: input.thread.id,
        turnId,
        diff: fallbackDiff ?? "",
        files: partialFiles,
        source: "derived_tool_results",
        coverage: "partial",
        ...(assistantMessageId ? { assistantMessageId } : {}),
        completedAt: input.event.createdAt,
        createdAt: input.event.createdAt,
      });
    },
  );

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap(
        Effect.fn("appendBufferedAssistantText")(function* (existingText) {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const takeBufferedProposedPlan = (planId: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedProposedPlanById, planId).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const clearAssistantMessageState = (messageId: MessageId) =>
    clearBufferedAssistantText(messageId);

  const finalizeAssistantMessage = Effect.fn("finalizeAssistantMessage")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
  }) {
    const bufferedText = yield* takeBufferedAssistantText(input.messageId);
    const text =
      bufferedText.length > 0
        ? bufferedText
        : (input.fallbackText?.trim().length ?? 0) > 0
          ? input.fallbackText!
          : "";

    if (text.length > 0) {
      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: providerCommandId(input.event, input.finalDeltaCommandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: text,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: providerCommandId(input.event, input.commandTag),
      threadId: input.threadId,
      messageId: input.messageId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      createdAt: input.createdAt,
    });
    yield* clearAssistantMessageState(input.messageId);
  });

  const upsertProposedPlan = Effect.fn("upsertProposedPlan")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    planMarkdown: string | undefined;
    createdAt: string;
    updatedAt: string;
  }) {
    const planMarkdown = normalizeProposedPlanMarkdown(input.planMarkdown);
    if (!planMarkdown) {
      return;
    }

    const existingPlan = input.threadProposedPlans.find((entry) => entry.id === input.planId);
    yield* orchestrationEngine.dispatch({
      type: "thread.proposed-plan.upsert",
      commandId: providerCommandId(input.event, "proposed-plan-upsert"),
      threadId: input.threadId,
      proposedPlan: {
        id: input.planId,
        turnId: input.turnId ?? null,
        planMarkdown,
        implementedAt: existingPlan?.implementedAt ?? null,
        implementationThreadId: existingPlan?.implementationThreadId ?? null,
        createdAt: existingPlan?.createdAt ?? input.createdAt,
        updatedAt: input.updatedAt,
      },
      createdAt: input.updatedAt,
    });
  });

  const finalizeBufferedProposedPlan = Effect.fn("finalizeBufferedProposedPlan")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) {
    const bufferedPlan = yield* takeBufferedProposedPlan(input.planId);
    const bufferedMarkdown = normalizeProposedPlanMarkdown(bufferedPlan?.text);
    const fallbackMarkdown = normalizeProposedPlanMarkdown(input.fallbackMarkdown);
    const planMarkdown = bufferedMarkdown ?? fallbackMarkdown;
    if (!planMarkdown) {
      return;
    }

    yield* upsertProposedPlan({
      event: input.event,
      threadId: input.threadId,
      threadProposedPlans: input.threadProposedPlans,
      planId: input.planId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      planMarkdown,
      createdAt:
        bufferedPlan?.createdAt && bufferedPlan.createdAt.length > 0
          ? bufferedPlan.createdAt
          : input.updatedAt,
      updatedAt: input.updatedAt,
    });
    yield* clearBufferedProposedPlan(input.planId);
  });

  const clearTurnStateForSession = Effect.fn("clearTurnStateForSession")(function* (
    threadId: ThreadId,
  ) {
    const prefix = `${threadId}:`;
    const proposedPlanPrefix = `plan:${threadId}:`;
    const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
    const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
    yield* Effect.forEach(
      turnKeys,
      Effect.fn(function* (key) {
        if (!key.startsWith(prefix)) {
          return;
        }

        const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
        if (Option.isSome(messageIds)) {
          yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
        }

        yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
      }),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(
      proposedPlanKeys,
      (key) =>
        key.startsWith(proposedPlanPrefix)
          ? Cache.invalidate(bufferedProposedPlanById, key)
          : Effect.void,
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
  });

  const getSourceProposedPlanReferenceForPendingTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForPendingTurnStart",
  )(function* (threadId: ThreadId) {
    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId,
    });
    if (Option.isNone(pendingTurnStart)) {
      return null;
    }

    const sourceThreadId = pendingTurnStart.value.sourceProposedPlanThreadId;
    const sourcePlanId = pendingTurnStart.value.sourceProposedPlanId;
    if (sourceThreadId === null || sourcePlanId === null) {
      return null;
    }

    return {
      sourceThreadId,
      sourcePlanId,
    } as const;
  });

  const getExpectedProviderTurnIdForThread = Effect.fn("getExpectedProviderTurnIdForThread")(
    function* (threadId: ThreadId) {
      const sessions = yield* providerService.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      return session?.activeTurnId;
    },
  );

  const getSourceProposedPlanReferenceForAcceptedTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForAcceptedTurnStart",
  )(function* (threadId: ThreadId, eventTurnId: TurnId | undefined) {
    if (eventTurnId === undefined) {
      return null;
    }

    const expectedTurnId = yield* getExpectedProviderTurnIdForThread(threadId);
    if (!sameId(expectedTurnId, eventTurnId)) {
      return null;
    }

    return yield* getSourceProposedPlanReferenceForPendingTurnStart(threadId);
  });

  const markSourceProposedPlanImplemented = Effect.fn("markSourceProposedPlanImplemented")(
    function* (
      sourceThreadId: ThreadId,
      sourcePlanId: OrchestrationProposedPlanId,
      implementationThreadId: ThreadId,
      implementedAt: string,
    ) {
      const readModel = yield* orchestrationEngine.getReadModel();
      const sourceThread = readModel.threads.find((entry) => entry.id === sourceThreadId);
      const sourcePlan = sourceThread?.proposedPlans.find((entry) => entry.id === sourcePlanId);
      if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
        return;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.makeUnsafe(
          `provider:source-proposed-plan-implemented:${implementationThreadId}:${crypto.randomUUID()}`,
        ),
        threadId: sourceThread.id,
        proposedPlan: {
          ...sourcePlan,
          implementedAt,
          implementationThreadId,
          updatedAt: implementedAt,
        },
        createdAt: implementedAt,
      });
    },
  );

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === event.threadId);
    if (!thread) return;

    const now = event.createdAt;
    const eventTurnId = toTurnId(event.turnId);
    const activeTurnId = thread.session?.activeTurnId ?? null;

    const conflictsWithActiveTurn =
      activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
    const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;

    const shouldApplyThreadLifecycle = (() => {
      if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
        return true;
      }
      switch (event.type) {
        case "session.exited":
          return true;
        case "session.started":
        case "thread.started":
          return true;
        case "turn.started":
          return !conflictsWithActiveTurn;
        case "turn.completed":
          if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
            return false;
          }
          // Only the active turn may close the lifecycle state.
          if (activeTurnId !== null && eventTurnId !== undefined) {
            return sameId(activeTurnId, eventTurnId);
          }
          // If no active turn is tracked, accept completion scoped to this thread.
          return true;
        default:
          return true;
      }
    })();
    const acceptedTurnStartedSourcePlan =
      event.type === "turn.started" && shouldApplyThreadLifecycle
        ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
        : null;

    if (
      event.type === "session.started" ||
      event.type === "session.state.changed" ||
      event.type === "session.exited" ||
      event.type === "thread.started" ||
      event.type === "turn.started" ||
      event.type === "turn.completed"
    ) {
      const nextActiveTurnId =
        event.type === "turn.started"
          ? (eventTurnId ?? null)
          : event.type === "turn.completed" || event.type === "session.exited"
            ? null
            : activeTurnId;
      const status = (() => {
        switch (event.type) {
          case "session.state.changed":
            return orchestrationSessionStatusFromRuntimeState(event.payload.state);
          case "turn.started":
            return "running";
          case "session.exited":
            return "stopped";
          case "turn.completed":
            return normalizeRuntimeTurnState(event.payload.state) === "failed" ? "error" : "ready";
          case "session.started":
          case "thread.started":
            // Provider thread/session start notifications can arrive during an
            // active turn; preserve turn-running state in that case.
            return activeTurnId !== null ? "running" : "ready";
        }
      })();
      const lastError =
        event.type === "session.state.changed" && event.payload.state === "error"
          ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
          : event.type === "turn.completed" &&
              normalizeRuntimeTurnState(event.payload.state) === "failed"
            ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
            : status === "ready"
              ? null
              : (thread.session?.lastError ?? null);

      if (shouldApplyThreadLifecycle) {
        if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
          yield* markSourceProposedPlanImplemented(
            acceptedTurnStartedSourcePlan.sourceThreadId,
            acceptedTurnStartedSourcePlan.sourcePlanId,
            thread.id,
            now,
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider runtime ingestion failed to mark source proposed plan", {
                eventId: event.eventId,
                eventType: event.type,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: providerCommandId(event, "thread-session-set"),
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status,
            providerName: event.provider,
            runtimeMode: thread.session?.runtimeMode ?? "full-access",
            activeTurnId: nextActiveTurnId,
            lastError,
            updatedAt: now,
          },
          createdAt: now,
        });
      }
    }

    const assistantDelta =
      event.type === "content.delta" && event.payload.streamKind === "assistant_text"
        ? event.payload.delta
        : undefined;
    const proposedPlanDelta =
      event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

    if (assistantDelta && assistantDelta.length > 0) {
      const assistantMessageId = MessageId.makeUnsafe(
        `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
      );
      const turnId = toTurnId(event.turnId);
      if (turnId) {
        yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
      }

      const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
        serverSettingsService.getSettings,
        (settings) => (settings.enableAssistantStreaming ? "streaming" : "buffered"),
      );
      if (assistantDeliveryMode === "buffered") {
        const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);
        if (spillChunk.length > 0) {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: providerCommandId(event, "assistant-delta-buffer-spill"),
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: spillChunk,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      } else {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: providerCommandId(event, "assistant-delta"),
          threadId: thread.id,
          messageId: assistantMessageId,
          delta: assistantDelta,
          ...(turnId ? { turnId } : {}),
          createdAt: now,
        });
      }
    }

    if (proposedPlanDelta && proposedPlanDelta.length > 0) {
      const planId = proposedPlanIdFromEvent(event, thread.id);
      yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
    }

    const assistantCompletion =
      event.type === "item.completed" && event.payload.itemType === "assistant_message"
        ? {
            messageId: MessageId.makeUnsafe(
              `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
            ),
            fallbackText: event.payload.detail,
          }
        : undefined;
    const proposedPlanCompletion =
      event.type === "turn.proposed.completed"
        ? {
            planId: proposedPlanIdFromEvent(event, thread.id),
            turnId: toTurnId(event.turnId),
            planMarkdown: event.payload.planMarkdown,
          }
        : undefined;

    if (assistantCompletion) {
      const assistantMessageId = assistantCompletion.messageId;
      const turnId = toTurnId(event.turnId);
      const existingAssistantMessage = thread.messages.find(
        (entry) => entry.id === assistantMessageId,
      );
      const shouldApplyFallbackCompletionText =
        !existingAssistantMessage || existingAssistantMessage.text.length === 0;
      if (turnId) {
        yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
      }

      yield* finalizeAssistantMessage({
        event,
        threadId: thread.id,
        messageId: assistantMessageId,
        ...(turnId ? { turnId } : {}),
        createdAt: now,
        commandTag: "assistant-complete",
        finalDeltaCommandTag: "assistant-delta-finalize",
        ...(assistantCompletion.fallbackText !== undefined && shouldApplyFallbackCompletionText
          ? { fallbackText: assistantCompletion.fallbackText }
          : {}),
      });

      if (turnId) {
        yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
      }
    }

    if (proposedPlanCompletion) {
      yield* finalizeBufferedProposedPlan({
        event,
        threadId: thread.id,
        threadProposedPlans: thread.proposedPlans,
        planId: proposedPlanCompletion.planId,
        ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
        fallbackMarkdown: proposedPlanCompletion.planMarkdown,
        updatedAt: now,
      });
    }

    if (event.type === "turn.completed") {
      const turnId = toTurnId(event.turnId);
      if (turnId) {
        const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
        yield* Effect.forEach(
          assistantMessageIds,
          (assistantMessageId) =>
            finalizeAssistantMessage({
              event,
              threadId: thread.id,
              messageId: assistantMessageId,
              turnId,
              createdAt: now,
              commandTag: "assistant-complete-finalize",
              finalDeltaCommandTag: "assistant-delta-finalize-fallback",
            }),
          { concurrency: 1 },
        ).pipe(Effect.asVoid);
        yield* clearAssistantMessageIdsForTurn(thread.id, turnId);

        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          threadProposedPlans: thread.proposedPlans,
          planId: proposedPlanIdForTurn(thread.id, turnId),
          turnId,
          updatedAt: now,
        });
      }
    }

    if (event.type === "session.exited") {
      yield* clearTurnStateForSession(thread.id);
    }

    if (event.type === "runtime.error") {
      const runtimeErrorMessage = event.payload.message;

      const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
        ? true
        : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

      if (shouldApplyRuntimeError) {
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: providerCommandId(event, "runtime-error-session-set"),
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "error",
            providerName: event.provider,
            runtimeMode: thread.session?.runtimeMode ?? "full-access",
            activeTurnId: eventTurnId ?? null,
            lastError: runtimeErrorMessage,
            updatedAt: now,
          },
          createdAt: now,
        });
      }
    }

    if (event.type === "thread.metadata.updated" && event.payload.name) {
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: providerCommandId(event, "thread-meta-update"),
        threadId: thread.id,
        title: event.payload.name,
      });
    }

    if (event.type === "turn.diff.updated") {
      const turnId = toTurnId(event.turnId);
      if (turnId) {
        const existingAgentDiff = yield* projectionAgentDiffRepository
          .getByTurnId({
            threadId: thread.id,
            turnId,
          })
          .pipe(Effect.catch(() => Effect.succeed(Option.none())));

        const incomingSource =
          event.payload.source ??
          (event.provider === "codex" ? "native_turn_diff" : "derived_tool_results");

        if (
          Option.isSome(existingAgentDiff) &&
          existingAgentDiff.value.source === "derived_tool_results" &&
          incomingSource === "native_turn_diff"
        ) {
          const workspaceCwd = yield* resolveWorkspaceCwdForThread(thread.id);
          const scopedPaths = existingAgentDiff.value.files.map((file) => file.path);
          if (workspaceCwd && scopedPaths.length > 0) {
            const filteredDiff =
              filterUnifiedDiffByPaths({
                diff: event.payload.unifiedDiff,
                allowedPaths: scopedPaths,
                workspaceRoot: workspaceCwd,
                ...(process.env.WSL_DISTRO_NAME
                  ? { wslDistroName: process.env.WSL_DISTRO_NAME }
                  : {}),
              }) ?? "";
            const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
            const assistantMessageId =
              [...assistantMessageIds].at(-1) ??
              existingAgentDiff.value.assistantMessageId ??
              undefined;

            yield* orchestrationEngine.dispatch({
              type: "thread.agent-diff.upsert",
              commandId: providerCommandId(event, "thread-agent-diff-upsert-native-filtered"),
              threadId: thread.id,
              turnId,
              diff: filteredDiff,
              files: mapUnifiedDiffToCheckpointFiles(filteredDiff),
              source: "derived_tool_results",
              coverage: event.payload.coverage ?? "complete",
              ...(assistantMessageId ? { assistantMessageId } : {}),
              completedAt: now,
              createdAt: now,
            });
          }
        } else {
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
          const assistantMessageId = [...assistantMessageIds].at(-1);
          const files = mapUnifiedDiffToCheckpointFiles(event.payload.unifiedDiff);
          yield* orchestrationEngine.dispatch({
            type: "thread.agent-diff.upsert",
            commandId: providerCommandId(event, "thread-agent-diff-upsert"),
            threadId: thread.id,
            turnId,
            diff: event.payload.unifiedDiff,
            files,
            source: incomingSource,
            coverage: event.payload.coverage ?? "complete",
            ...(assistantMessageId ? { assistantMessageId } : {}),
            completedAt: now,
            createdAt: now,
          });
        }
      }

      if (turnId && event.provider === "codex" && (yield* isGitRepoForThread(thread.id))) {
        // Skip if a checkpoint already exists for this turn. A real
        // (non-placeholder) capture from CheckpointReactor should not
        // be clobbered, and dispatching a duplicate placeholder for the
        // same turnId would produce an unstable checkpointTurnCount.
        if (thread.checkpoints.some((c) => c.turnId === turnId)) {
          // Already tracked; no-op.
        } else {
          const assistantMessageId = MessageId.makeUnsafe(
            `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
          );
          const maxTurnCount = thread.checkpoints.reduce(
            (max, c) => Math.max(max, c.checkpointTurnCount),
            0,
          );
          yield* orchestrationEngine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: providerCommandId(event, "thread-turn-diff-complete"),
            threadId: thread.id,
            turnId,
            completedAt: now,
            checkpointRef: CheckpointRef.makeUnsafe(`provider-diff:${event.eventId}`),
            status: "missing",
            files: [],
            assistantMessageId,
            checkpointTurnCount: maxTurnCount + 1,
            createdAt: now,
          });
        }
      }
    }

    if (
      (event.type === "item.updated" || event.type === "item.completed") &&
      event.payload.itemType === "file_change"
    ) {
      const inlineDiff = buildToolInlineDiffArtifact(event.payload.data);
      if (inlineDiff) {
        yield* refreshTurnAgentDiffFromToolArtifact({
          event,
          thread,
          inlineDiff,
        });
      }
    }

    const activities = runtimeEventToActivities(event);
    yield* Effect.forEach(activities, (activity) =>
      orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: providerCommandId(event, "thread-activity-append"),
        threadId: thread.id,
        activity,
        createdAt: activity.createdAt,
      }),
    ).pipe(Effect.asVoid);
  });

  const processDomainEvent = (_event: TurnStartRequestedDomainEvent) => Effect.void;

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime" ? processRuntimeEvent(input.event) : processDomainEvent(input.event);

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          eventId: input.event.eventId,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: ProviderRuntimeIngestionShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        worker.enqueue({ source: "runtime", event }),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.turn-start-requested") {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make(),
).pipe(
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionAgentDiffRepositoryLive),
);
