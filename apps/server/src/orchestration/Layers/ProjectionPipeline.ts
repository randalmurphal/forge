import {
  ApprovalRequestId,
  CheckpointRef,
  type ChatAttachment,
  type ForgeEvent,
  WorkflowId,
} from "@forgetools/contracts";
import { resolveThreadSpawnMode } from "@forgetools/shared/threadWorkspace";
import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionAgentDiffRepository } from "../../persistence/Services/ProjectionAgentDiffs.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionChannelMessageRepository } from "../../persistence/Services/ProjectionChannelMessages.ts";
import { ProjectionChannelReadRepository } from "../../persistence/Services/ProjectionChannelReads.ts";
import { ProjectionChannelRepository } from "../../persistence/Services/ProjectionChannels.ts";
import { ProjectionInteractiveRequestRepository } from "../../persistence/Services/ProjectionInteractiveRequests.ts";
import { ProjectionPhaseOutputRepository } from "../../persistence/Services/ProjectionPhaseOutputs.ts";
import { ProjectionPhaseRunRepository } from "../../persistence/Services/ProjectionPhaseRuns.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { type ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import {
  type ProjectionThreadMessage,
  ProjectionThreadMessageRepository,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  type ProjectionThreadProposedPlan,
  ProjectionThreadProposedPlanRepository,
} from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import {
  type ProjectionTurn,
  ProjectionTurnRepository,
} from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionAgentDiffRepositoryLive } from "../../persistence/Layers/ProjectionAgentDiffs.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionChannelMessageRepositoryLive } from "../../persistence/Layers/ProjectionChannelMessages.ts";
import { ProjectionChannelReadRepositoryLive } from "../../persistence/Layers/ProjectionChannelReads.ts";
import { ProjectionChannelRepositoryLive } from "../../persistence/Layers/ProjectionChannels.ts";
import { ProjectionInteractiveRequestRepositoryLive } from "../../persistence/Layers/ProjectionInteractiveRequests.ts";
import { ProjectionPhaseOutputRepositoryLive } from "../../persistence/Layers/ProjectionPhaseOutputs.ts";
import { ProjectionPhaseRunRepositoryLive } from "../../persistence/Layers/ProjectionPhaseRuns.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ServerConfig } from "../../config.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import {
  attachmentRelativePath,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";

export const ORCHESTRATION_PROJECTOR_NAMES = {
  projects: "projection.projects",
  threads: "projection.threads",
  phaseRuns: "projection.phase-runs",
  channels: "projection.channels",
  channelMessages: "projection.channel-messages",
  channelReads: "projection.channel-reads",
  phaseOutputs: "projection.phase-outputs",
  threadMessages: "projection.thread-messages",
  threadProposedPlans: "projection.thread-proposed-plans",
  threadActivities: "projection.thread-activities",
  threadSessions: "projection.thread-sessions",
  threadTurns: "projection.thread-turns",
  checkpoints: "projection.checkpoints",
  agentDiffs: "projection.agent-diffs",
  pendingApprovals: "projection.pending-approvals",
  interactiveRequests: "projection.interactive-requests",
} as const;

type ProjectorName =
  (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES];

interface ProjectorDefinition {
  readonly name: ProjectorName;
  readonly apply: (
    event: ForgeEvent,
    attachmentSideEffects: AttachmentSideEffects,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

interface AttachmentSideEffects {
  readonly deletedThreadIds: Set<string>;
  readonly prunedThreadRelativePaths: Map<string, Set<string>>;
}

const materializeAttachmentsForProjection = Effect.fn("materializeAttachmentsForProjection")(
  (input: { readonly attachments: ReadonlyArray<ChatAttachment> }) =>
    Effect.succeed(input.attachments.length === 0 ? [] : input.attachments),
);

type ThreadMessageSentEvent = Extract<ForgeEvent, { type: "thread.message-sent" }>;

function threadMessageText(payload: ThreadMessageSentEvent["payload"]): string {
  return "text" in payload ? payload.text : payload.content;
}

function threadMessageAttachments(
  payload: ThreadMessageSentEvent["payload"],
): ReadonlyArray<ChatAttachment> | undefined {
  return "attachments" in payload ? payload.attachments : undefined;
}

function threadMessageUpdatedAt(payload: ThreadMessageSentEvent["payload"]): string {
  return "updatedAt" in payload ? payload.updatedAt : payload.createdAt;
}

function threadMessageAttribution(
  payload: ThreadMessageSentEvent["payload"],
): ProjectionThreadMessage["attribution"] | undefined {
  return "attribution" in payload ? payload.attribution : undefined;
}

function toProjectionMessageRole(
  role: ThreadMessageSentEvent["payload"]["role"],
): ProjectionThreadMessage["role"] | null {
  switch (role) {
    case "user":
    case "assistant":
    case "system":
      return role;
    default:
      return null;
  }
}

function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.makeUnsafe(requestId) : null;
}

function toPendingApprovalRequestId(requestId: string | ApprovalRequestId): ApprovalRequestId {
  return ApprovalRequestId.makeUnsafe(String(requestId));
}

function retainProjectionMessagesAfterRevert(
  messages: ReadonlyArray<ProjectionThreadMessage>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadMessage> {
  const retainedMessageIds = new Set<string>();
  const retainedTurnIds = new Set<string>();
  const keptTurns = turns.filter(
    (turn) =>
      turn.turnId !== null &&
      turn.checkpointTurnCount !== null &&
      turn.checkpointTurnCount <= turnCount,
  );
  for (const turn of keptTurns) {
    if (turn.turnId !== null) {
      retainedTurnIds.add(turn.turnId);
    }
    if (turn.pendingMessageId !== null) {
      retainedMessageIds.add(turn.pendingMessageId);
    }
    if (turn.assistantMessageId !== null) {
      retainedMessageIds.add(turn.assistantMessageId);
    }
  }

  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.messageId);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.messageId));
}

function retainProjectionActivitiesAfterRevert(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadActivity> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainProjectionProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadProposedPlan> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function collectThreadAttachmentRelativePaths(
  threadId: string,
  messages: ReadonlyArray<ProjectionThreadMessage>,
): Set<string> {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return new Set();
  }
  const relativePaths = new Set<string>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachment.id);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        continue;
      }
      relativePaths.add(attachmentRelativePath(attachment));
    }
  }
  return relativePaths;
}

const runAttachmentSideEffects = Effect.fn("runAttachmentSideEffects")(function* (
  sideEffects: AttachmentSideEffects,
) {
  const serverConfig = yield* Effect.service(ServerConfig);
  const fileSystem = yield* Effect.service(FileSystem.FileSystem);
  const path = yield* Effect.service(Path.Path);

  const attachmentsRootDir = serverConfig.attachmentsDir;
  const readAttachmentRootEntries = fileSystem
    .readDirectory(attachmentsRootDir, { recursive: false })
    .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));

  const removeDeletedThreadAttachmentEntry = Effect.fn("removeDeletedThreadAttachmentEntry")(
    function* (threadSegment: string, entry: string) {
      const normalizedEntry = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
      if (normalizedEntry.length === 0 || normalizedEntry.includes("/")) {
        return;
      }
      const attachmentId = parseAttachmentIdFromRelativePath(normalizedEntry);
      if (!attachmentId) {
        return;
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        return;
      }
      yield* fileSystem.remove(path.join(attachmentsRootDir, normalizedEntry), {
        force: true,
      });
    },
  );

  const deleteThreadAttachments = Effect.fn("deleteThreadAttachments")(function* (
    threadId: string,
  ) {
    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      yield* Effect.logWarning("skipping attachment cleanup for unsafe thread id", {
        threadId,
      });
      return;
    }

    const entries = yield* readAttachmentRootEntries;
    yield* Effect.forEach(
      entries,
      (entry) => removeDeletedThreadAttachmentEntry(threadSegment, entry),
      {
        concurrency: 1,
      },
    );
  });

  const pruneThreadAttachmentEntry = Effect.fn("pruneThreadAttachmentEntry")(function* (
    threadSegment: string,
    keptThreadRelativePaths: Set<string>,
    entry: string,
  ) {
    const relativePath = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
    if (relativePath.length === 0 || relativePath.includes("/")) {
      return;
    }
    const attachmentId = parseAttachmentIdFromRelativePath(relativePath);
    if (!attachmentId) {
      return;
    }
    const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
      return;
    }

    const absolutePath = path.join(attachmentsRootDir, relativePath);
    const fileInfo = yield* fileSystem
      .stat(absolutePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return;
    }

    if (!keptThreadRelativePaths.has(relativePath)) {
      yield* fileSystem.remove(absolutePath, { force: true });
    }
  });

  const pruneThreadAttachments = Effect.fn("pruneThreadAttachments")(function* (
    threadId: string,
    keptThreadRelativePaths: Set<string>,
  ) {
    if (sideEffects.deletedThreadIds.has(threadId)) {
      return;
    }

    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      yield* Effect.logWarning("skipping attachment prune for unsafe thread id", { threadId });
      return;
    }

    const entries = yield* readAttachmentRootEntries;
    yield* Effect.forEach(
      entries,
      (entry) => pruneThreadAttachmentEntry(threadSegment, keptThreadRelativePaths, entry),
      { concurrency: 1 },
    );
  });

  yield* Effect.forEach(sideEffects.deletedThreadIds, deleteThreadAttachments, {
    concurrency: 1,
  });

  yield* Effect.forEach(
    sideEffects.prunedThreadRelativePaths.entries(),
    ([threadId, keptThreadRelativePaths]) =>
      pruneThreadAttachments(threadId, keptThreadRelativePaths),
    { concurrency: 1 },
  );
});

const makeOrchestrationProjectionPipeline = Effect.fn("makeOrchestrationProjectionPipeline")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* OrchestrationEventStore;
    const projectionStateRepository = yield* ProjectionStateRepository;
    const projectionProjectRepository = yield* ProjectionProjectRepository;
    const projectionThreadRepository = yield* ProjectionThreadRepository;
    const projectionPhaseRunRepository = yield* ProjectionPhaseRunRepository;
    const projectionChannelRepository = yield* ProjectionChannelRepository;
    const projectionChannelMessageRepository = yield* ProjectionChannelMessageRepository;
    const projectionChannelReadRepository = yield* ProjectionChannelReadRepository;
    const projectionPhaseOutputRepository = yield* ProjectionPhaseOutputRepository;
    const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
    const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;
    const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
    const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
    const projectionTurnRepository = yield* ProjectionTurnRepository;
    const projectionAgentDiffRepository = yield* ProjectionAgentDiffRepository;
    const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;
    const projectionInteractiveRequestRepository = yield* ProjectionInteractiveRequestRepository;

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;

    const applyProjectsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyProjectsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "project.created":
          yield* projectionProjectRepository.upsert({
            projectId: event.payload.projectId,
            title: event.payload.title,
            workspaceRoot: event.payload.workspaceRoot,
            defaultModelSelection: event.payload.defaultModelSelection,
            scripts: event.payload.scripts,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            deletedAt: null,
          });
          return;

        case "project.meta-updated": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.workspaceRoot !== undefined
              ? { workspaceRoot: event.payload.workspaceRoot }
              : {}),
            ...(event.payload.defaultModelSelection !== undefined
              ? { defaultModelSelection: event.payload.defaultModelSelection }
              : {}),
            ...(event.payload.scripts !== undefined ? { scripts: event.payload.scripts } : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "project.deleted": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const applyThreadsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadsProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          if (!("modelSelection" in event.payload) || !("interactionMode" in event.payload)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            threadId: event.payload.threadId,
            projectId: event.payload.projectId,
            title: event.payload.title,
            modelSelection: event.payload.modelSelection,
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
            branch: event.payload.branch,
            worktreePath: event.payload.worktreePath,
            spawnMode: resolveThreadSpawnMode({
              branch: event.payload.branch,
              worktreePath: event.payload.worktreePath,
              spawnMode: event.payload.spawnMode,
              spawnBranch: event.payload.spawnBranch,
              spawnWorktreePath: event.payload.spawnWorktreePath,
            }),
            spawnBranch:
              event.payload.spawnBranch !== undefined
                ? event.payload.spawnBranch
                : event.payload.branch,
            spawnWorktreePath:
              event.payload.spawnWorktreePath !== undefined
                ? event.payload.spawnWorktreePath
                : event.payload.worktreePath,
            latestTurnId: null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            pinnedAt: null,
            archivedAt: null,
            deletedAt: null,
            parentThreadId: event.payload.parentThreadId ?? null,
            forkedFromThreadId:
              "forkedFromThreadId" in event.payload
                ? (event.payload.forkedFromThreadId ?? null)
                : null,
            phaseRunId: null,
            workflowId: event.payload.workflowId ?? null,
            workflowSnapshot: null,
            currentPhaseId: null,
            discussionId: event.payload.discussionId ?? null,
            role: event.payload.role ?? null,
            deliberationState: null,
            bootstrapStatus: null,
            completedAt: null,
            transcriptArchived: false,
          });
          return;

        case "thread.archived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: event.payload.archivedAt,
            updatedAt:
              "updatedAt" in event.payload ? event.payload.updatedAt : event.payload.archivedAt,
          });
          return;
        }

        case "thread.unarchived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pinned": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinnedAt: event.payload.pinnedAt,
          });
          return;
        }

        case "thread.unpinned": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinnedAt: null,
          });
          return;
        }

        case "thread.meta-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.modelSelection !== undefined
              ? { modelSelection: event.payload.modelSelection }
              : {}),
            ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
            ...(event.payload.worktreePath !== undefined
              ? { worktreePath: event.payload.worktreePath }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.runtime-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            runtimeMode: event.payload.runtimeMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.interaction-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            interactionMode: event.payload.interactionMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.deleted": {
          attachmentSideEffects.deletedThreadIds.add(event.payload.threadId);
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        case "thread.message-sent":
        case "thread.proposed-plan-upserted":
        case "thread.activity-appended":
        case "thread.activity-inline-diff-upserted": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.turn-requested":
          yield* touchProjectionThread({
            threadId: event.payload.threadId,
            updatedAt: event.payload.createdAt,
          });
          return;

        case "thread.turn-started": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.turnId,
            updatedAt: event.payload.startedAt,
          });
          return;
        }

        case "thread.turn-completed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.turnId,
            updatedAt: event.payload.completedAt,
          });
          return;
        }

        case "thread.turn-restarted":
          yield* touchProjectionThread({
            threadId: event.payload.threadId,
            updatedAt: event.payload.restartedAt,
          });
          return;

        case "thread.checkpoint-captured": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.turnId,
            updatedAt: event.payload.capturedAt,
          });
          return;
        }

        case "thread.checkpoint-diff-completed":
          yield* touchProjectionThread({
            threadId: event.payload.threadId,
            updatedAt: event.payload.completedAt,
          });
          return;

        case "thread.checkpoint-reverted": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: null,
            updatedAt: event.payload.revertedAt,
          });
          return;
        }

        case "thread.session-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.session.activeTurnId,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.turn-diff-completed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.turnId,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.reverted": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: null,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.phase-started":
          yield* setProjectionThreadPhaseState({
            threadId: event.payload.threadId,
            phaseRunId: event.payload.phaseRunId,
            currentPhaseId: event.payload.phaseId,
            updatedAt: event.payload.startedAt,
          });
          return;

        case "thread.phase-completed":
          yield* setProjectionThreadPhaseState({
            threadId: event.payload.threadId,
            phaseRunId: null,
            currentPhaseId: null,
            updatedAt: event.payload.completedAt,
          });
          return;

        case "thread.phase-failed":
          yield* setProjectionThreadPhaseState({
            threadId: event.payload.threadId,
            phaseRunId: null,
            currentPhaseId: null,
            updatedAt: event.payload.failedAt,
          });
          return;

        case "thread.phase-skipped":
          yield* setProjectionThreadPhaseState({
            threadId: event.payload.threadId,
            phaseRunId: null,
            currentPhaseId: null,
            updatedAt: event.payload.skippedAt,
          });
          return;

        case "thread.phase-output-edited":
          yield* touchProjectionThread({
            threadId: event.payload.threadId,
            updatedAt: event.payload.editedAt,
          });
          return;

        case "thread.quality-check-started":
          yield* touchProjectionThread({
            threadId: event.payload.threadId,
            updatedAt: event.payload.startedAt,
          });
          return;

        case "thread.quality-check-completed":
          yield* touchProjectionThread({
            threadId: event.payload.threadId,
            updatedAt: event.payload.completedAt,
          });
          return;

        case "thread.bootstrap-queued":
          yield* setProjectionThreadBootstrapStatus({
            threadId: event.payload.threadId,
            bootstrapStatus: "queued",
            updatedAt: event.payload.queuedAt,
          });
          return;

        case "thread.bootstrap-started":
          yield* setProjectionThreadBootstrapStatus({
            threadId: event.payload.threadId,
            bootstrapStatus: "running",
            updatedAt: event.payload.startedAt,
          });
          return;

        case "thread.bootstrap-completed":
          yield* setProjectionThreadBootstrapStatus({
            threadId: event.payload.threadId,
            bootstrapStatus: "completed",
            updatedAt: event.payload.completedAt,
          });
          return;

        case "thread.bootstrap-failed":
          yield* setProjectionThreadBootstrapStatus({
            threadId: event.payload.threadId,
            bootstrapStatus: "failed",
            updatedAt: event.payload.failedAt,
          });
          return;

        case "thread.bootstrap-skipped":
          yield* setProjectionThreadBootstrapStatus({
            threadId: event.payload.threadId,
            bootstrapStatus: "skipped",
            updatedAt: event.payload.skippedAt,
          });
          return;

        case "thread.correction-queued":
          yield* touchProjectionThread({
            threadId: event.payload.threadId,
            updatedAt: event.payload.createdAt,
          });
          return;

        case "thread.correction-delivered":
          yield* touchProjectionThread({
            threadId: event.payload.threadId,
            updatedAt: event.payload.deliveredAt,
          });
          return;

        case "thread.link-added":
          yield* touchProjectionThread({
            threadId: event.payload.threadId,
            updatedAt: event.payload.createdAt,
          });
          return;

        case "thread.link-removed":
          yield* touchProjectionThread({
            threadId: event.payload.threadId,
            updatedAt: event.payload.removedAt,
          });
          return;

        case "thread.promoted":
          yield* touchProjectionThread({
            threadId: event.payload.sourceThreadId,
            updatedAt: event.payload.promotedAt,
          });
          yield* setProjectionThreadParent({
            threadId: event.payload.targetThreadId,
            parentThreadId: event.payload.sourceThreadId,
            updatedAt: event.payload.promotedAt,
          });
          return;

        case "channel.created":
          yield* touchProjectionThread({
            threadId: event.payload.threadId,
            updatedAt: event.payload.createdAt,
          });
          return;

        case "channel.message-posted": {
          const threadId = yield* lookupThreadIdByChannelId(event.payload.channelId);
          if (threadId === null) {
            return;
          }
          yield* touchProjectionThread({
            threadId,
            updatedAt: event.payload.createdAt,
          });
          return;
        }

        case "channel.conclusion-proposed":
          yield* touchProjectionThread({
            threadId: event.payload.threadId,
            updatedAt: event.payload.proposedAt,
          });
          return;

        case "channel.concluded": {
          const threadId = yield* lookupThreadIdByChannelId(event.payload.channelId);
          if (threadId === null) {
            return;
          }
          yield* touchProjectionThread({
            threadId,
            updatedAt: event.payload.concludedAt,
          });
          return;
        }

        case "channel.closed": {
          const threadId = yield* lookupThreadIdByChannelId(event.payload.channelId);
          if (threadId === null) {
            return;
          }
          yield* touchProjectionThread({
            threadId,
            updatedAt: event.payload.closedAt,
          });
          return;
        }

        case "request.opened":
          yield* touchProjectionThread({
            threadId: event.payload.threadId,
            updatedAt: event.payload.createdAt,
          });
          return;

        case "request.resolved": {
          const threadId = yield* lookupThreadIdByRequestId(event.payload.requestId);
          if (threadId === null) {
            return;
          }
          yield* touchProjectionThread({
            threadId,
            updatedAt: event.payload.resolvedAt,
          });
          return;
        }

        case "request.stale": {
          const threadId = yield* lookupThreadIdByRequestId(event.payload.requestId);
          if (threadId === null) {
            return;
          }
          yield* touchProjectionThread({
            threadId,
            updatedAt: event.payload.staleAt,
          });
          return;
        }

        case "thread.dependency-added":
          yield* touchProjectionThread({
            threadId: event.payload.threadId,
            updatedAt: event.payload.createdAt,
          });
          return;

        case "thread.dependency-removed":
          yield* touchProjectionThread({
            threadId: event.payload.threadId,
            updatedAt: event.payload.removedAt,
          });
          return;

        case "thread.dependencies-satisfied":
          yield* touchProjectionThread({
            threadId: event.payload.threadId,
            updatedAt: event.payload.satisfiedAt,
          });
          return;

        case "thread.synthesis-completed":
          yield* touchProjectionThread({
            threadId: event.payload.threadId,
            updatedAt: event.payload.completedAt,
          });
          return;

        default:
          return;
      }
    });

    const lookupThreadWorkflowId = Effect.fn("lookupThreadWorkflowId")(function* (
      threadId: string,
    ) {
      const rows = yield* sql<{ readonly workflowId: string | null }>`
          SELECT workflow_id AS "workflowId"
          FROM projection_threads
          WHERE thread_id = ${threadId}
          LIMIT 1
        `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionPipeline.lookupThreadWorkflowId:query")),
      );
      const workflowId = rows[0]?.workflowId ?? null;
      return workflowId === null ? null : WorkflowId.makeUnsafe(workflowId);
    });

    const lookupThreadIdByChannelId = Effect.fn("lookupThreadIdByChannelId")(function* (
      channelId: string,
    ) {
      const rows = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId"
          FROM channels
          WHERE channel_id = ${channelId}
          LIMIT 1
        `.pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionPipeline.lookupThreadIdByChannelId:query"),
        ),
      );
      return rows[0]?.threadId ?? null;
    });

    const lookupNextChannelMessageSequence = Effect.fn("lookupNextChannelMessageSequence")(
      function* (channelId: string) {
        const rows = yield* sql<{ readonly nextSequence: number }>`
          SELECT
            COALESCE(MAX(sequence), -1) + 1 AS "nextSequence"
          FROM channel_messages
          WHERE channel_id = ${channelId}
        `.pipe(
          Effect.mapError(
            toPersistenceSqlError("ProjectionPipeline.lookupNextChannelMessageSequence:query"),
          ),
        );
        return rows[0]?.nextSequence ?? 0;
      },
    );

    const lookupThreadIdByRequestId = Effect.fn("lookupThreadIdByRequestId")(function* (
      requestId: string,
    ) {
      const rows = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId"
          FROM interactive_requests
          WHERE request_id = ${requestId}
          LIMIT 1
        `.pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionPipeline.lookupThreadIdByRequestId:query"),
        ),
      );
      return rows[0]?.threadId ?? null;
    });

    const touchProjectionThread = Effect.fn("touchProjectionThread")(function* (input: {
      readonly threadId: string;
      readonly updatedAt: string;
    }) {
      yield* sql`
        UPDATE projection_threads
        SET updated_at = ${input.updatedAt}
        WHERE thread_id = ${input.threadId}
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionPipeline.touchProjectionThread:query")),
      );
    });

    const setProjectionThreadPhaseState = Effect.fn("setProjectionThreadPhaseState")(
      function* (input: {
        readonly threadId: string;
        readonly phaseRunId: string | null;
        readonly currentPhaseId: string | null;
        readonly updatedAt: string;
      }) {
        yield* sql`
        UPDATE projection_threads
        SET
          phase_run_id = ${input.phaseRunId},
          current_phase_id = ${input.currentPhaseId},
          updated_at = ${input.updatedAt}
        WHERE thread_id = ${input.threadId}
      `.pipe(
          Effect.mapError(
            toPersistenceSqlError("ProjectionPipeline.setProjectionThreadPhaseState:query"),
          ),
        );
      },
    );

    const setProjectionThreadBootstrapStatus = Effect.fn("setProjectionThreadBootstrapStatus")(
      function* (input: {
        readonly threadId: string;
        readonly bootstrapStatus: string;
        readonly updatedAt: string;
      }) {
        yield* sql`
        UPDATE projection_threads
        SET
          bootstrap_status = ${input.bootstrapStatus},
          updated_at = ${input.updatedAt}
        WHERE thread_id = ${input.threadId}
      `.pipe(
          Effect.mapError(
            toPersistenceSqlError("ProjectionPipeline.setProjectionThreadBootstrapStatus:query"),
          ),
        );
      },
    );

    const setProjectionThreadParent = Effect.fn("setProjectionThreadParent")(function* (input: {
      readonly threadId: string;
      readonly parentThreadId: string | null;
      readonly updatedAt: string;
    }) {
      yield* sql`
        UPDATE projection_threads
        SET
          parent_thread_id = ${input.parentThreadId},
          updated_at = ${input.updatedAt}
        WHERE thread_id = ${input.threadId}
      `.pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionPipeline.setProjectionThreadParent:query"),
        ),
      );
    });

    const applyPhaseRunsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyPhaseRunsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.phase-started": {
          const workflowId = yield* lookupThreadWorkflowId(event.payload.threadId);
          if (workflowId === null) {
            return;
          }
          yield* projectionPhaseRunRepository.upsert({
            phaseRunId: event.payload.phaseRunId,
            threadId: event.payload.threadId,
            workflowId,
            phaseId: event.payload.phaseId,
            phaseName: event.payload.phaseName,
            phaseType: event.payload.phaseType,
            sandboxMode: null,
            iteration: event.payload.iteration,
            status: "running",
            gateResult: null,
            qualityChecks: null,
            deliberationState: null,
            startedAt: event.payload.startedAt,
            completedAt: null,
          });
          return;
        }

        case "thread.phase-completed":
          yield* projectionPhaseRunRepository.updateStatus({
            phaseRunId: event.payload.phaseRunId,
            status: "completed",
            gateResult: event.payload.gateResult ?? null,
            completedAt: event.payload.completedAt,
          });
          return;

        case "thread.phase-failed":
          yield* projectionPhaseRunRepository.updateStatus({
            phaseRunId: event.payload.phaseRunId,
            status: "failed",
            completedAt: event.payload.failedAt,
          });
          return;

        case "thread.phase-skipped":
          yield* projectionPhaseRunRepository.updateStatus({
            phaseRunId: event.payload.phaseRunId,
            status: "skipped",
            completedAt: event.payload.skippedAt,
          });
          return;

        case "thread.quality-check-completed":
          yield* projectionPhaseRunRepository
            .queryById({
              phaseRunId: event.payload.phaseRunId,
            })
            .pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.void,
                  onSome: (row) =>
                    projectionPhaseRunRepository.updateStatus({
                      phaseRunId: event.payload.phaseRunId,
                      status: row.status,
                      qualityChecks: event.payload.results,
                    }),
                }),
              ),
            );
          return;

        default:
          return;
      }
    });

    const applyChannelsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyChannelsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "channel.created":
          yield* projectionChannelRepository.create({
            channelId: event.payload.channelId,
            threadId: event.payload.threadId,
            phaseRunId: event.payload.phaseRunId,
            type: event.payload.channelType,
            status: "open",
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.createdAt,
          });
          return;

        case "thread.correction-queued":
          yield* projectionChannelRepository
            .queryByThreadId({
              threadId: event.payload.threadId,
            })
            .pipe(
              Effect.flatMap((channels) => {
                const existingChannel = channels.find(
                  (channel) => channel.channelId === event.payload.channelId,
                );
                return existingChannel === undefined
                  ? projectionChannelRepository.create({
                      channelId: event.payload.channelId,
                      threadId: event.payload.threadId,
                      phaseRunId: null,
                      type: "guidance",
                      status: "open",
                      createdAt: event.payload.createdAt,
                      updatedAt: event.payload.createdAt,
                    })
                  : projectionChannelRepository.updateStatus({
                      channelId: event.payload.channelId,
                      status: existingChannel.status,
                      updatedAt: event.payload.createdAt,
                    });
              }),
            );
          return;

        case "channel.concluded":
          yield* projectionChannelRepository.updateStatus({
            channelId: event.payload.channelId,
            status: "concluded",
            updatedAt: event.payload.concludedAt,
          });
          return;

        case "channel.closed":
          yield* projectionChannelRepository.updateStatus({
            channelId: event.payload.channelId,
            status: "closed",
            updatedAt: event.payload.closedAt,
          });
          return;

        default:
          return;
      }
    });

    const applyChannelMessagesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyChannelMessagesProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "channel.message-posted":
          yield* projectionChannelMessageRepository.insert({
            messageId: event.payload.messageId,
            channelId: event.payload.channelId,
            sequence: event.payload.sequence,
            fromType: event.payload.fromType,
            fromId: event.payload.fromId,
            fromRole: event.payload.fromRole,
            content: event.payload.content,
            metadata: null,
            createdAt: event.payload.createdAt,
            deletedAt: null,
          });
          return;

        case "thread.correction-queued": {
          const nextSequence = yield* lookupNextChannelMessageSequence(event.payload.channelId);
          yield* projectionChannelMessageRepository.insert({
            messageId: event.payload.messageId,
            channelId: event.payload.channelId,
            sequence: nextSequence,
            fromType: "human",
            fromId: "human",
            fromRole: null,
            content: event.payload.content,
            metadata: null,
            createdAt: event.payload.createdAt,
            deletedAt: null,
          });
          return;
        }

        default:
          return;
      }
    });

    const applyChannelReadsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyChannelReadsProjection",
    )(function* (event, _attachmentSideEffects) {
      if (event.type !== "channel.messages-read") {
        return;
      }

      yield* projectionChannelReadRepository.updateCursor({
        channelId: event.payload.channelId,
        threadId: event.payload.threadId,
        lastReadSequence: event.payload.upToSequence,
        updatedAt: event.payload.readAt,
      });
    });

    const applyPhaseOutputsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyPhaseOutputsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.phase-completed":
          yield* Effect.forEach(
            event.payload.outputs,
            (output) =>
              projectionPhaseOutputRepository
                .queryByKey({
                  phaseRunId: event.payload.phaseRunId,
                  outputKey: output.key,
                })
                .pipe(
                  Effect.flatMap((existingRow) =>
                    projectionPhaseOutputRepository.upsert({
                      phaseRunId: event.payload.phaseRunId,
                      outputKey: output.key,
                      content: output.content,
                      sourceType: output.sourceType,
                      sourceId: null,
                      metadata: null,
                      createdAt: Option.match(existingRow, {
                        onNone: () => event.payload.completedAt,
                        onSome: (row) => row.createdAt,
                      }),
                      updatedAt: event.payload.completedAt,
                    }),
                  ),
                ),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          return;

        case "thread.phase-output-edited":
          yield* projectionPhaseOutputRepository
            .queryByKey({
              phaseRunId: event.payload.phaseRunId,
              outputKey: event.payload.outputKey,
            })
            .pipe(
              Effect.flatMap((existingRow) =>
                projectionPhaseOutputRepository.upsert({
                  phaseRunId: event.payload.phaseRunId,
                  outputKey: event.payload.outputKey,
                  content: event.payload.newContent,
                  sourceType: Option.match(existingRow, {
                    onNone: () => "human",
                    onSome: (row) => row.sourceType,
                  }),
                  sourceId: Option.match(existingRow, {
                    onNone: () => null,
                    onSome: (row) => row.sourceId,
                  }),
                  metadata: Option.match(existingRow, {
                    onNone: () => null,
                    onSome: (row) => row.metadata,
                  }),
                  createdAt: Option.match(existingRow, {
                    onNone: () => event.payload.editedAt,
                    onSome: (row) => row.createdAt,
                  }),
                  updatedAt: event.payload.editedAt,
                }),
              ),
            );
          return;

        default:
          return;
      }
    });

    const applyInteractiveRequestsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyInteractiveRequestsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "request.opened":
          yield* projectionInteractiveRequestRepository.upsert({
            requestId: event.payload.requestId,
            threadId: event.payload.threadId,
            childThreadId: event.payload.childThreadId,
            phaseRunId: event.payload.phaseRunId,
            type: event.payload.requestType,
            status: "pending",
            payload: event.payload.payload,
            resolvedWith: null,
            createdAt: event.payload.createdAt,
            resolvedAt: null,
            staleReason: null,
          });
          return;

        case "request.resolved":
          yield* projectionInteractiveRequestRepository.updateStatus({
            requestId: event.payload.requestId,
            status: "resolved",
            resolvedWith: event.payload.resolvedWith,
            resolvedAt: event.payload.resolvedAt,
          });
          return;

        case "request.stale":
          yield* projectionInteractiveRequestRepository.markStale({
            requestId: event.payload.requestId,
            staleReason: event.payload.reason,
          });
          return;

        default:
          return;
      }
    });

    const applyThreadMessagesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadMessagesProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.message-sent": {
          const role = toProjectionMessageRole(event.payload.role);
          if (role === null) {
            return;
          }
          const existingMessage = yield* projectionThreadMessageRepository.getByMessageId({
            messageId: event.payload.messageId,
          });
          const previousMessage = Option.getOrUndefined(existingMessage);
          const nextText = Option.match(existingMessage, {
            onNone: () => threadMessageText(event.payload),
            onSome: (message) => {
              if (event.payload.streaming) {
                return `${message.text}${threadMessageText(event.payload)}`;
              }
              const currentText = threadMessageText(event.payload);
              if (currentText.length === 0) {
                return message.text;
              }
              return currentText;
            },
          });
          const payloadAttachments = threadMessageAttachments(event.payload);
          const nextAttachments =
            payloadAttachments !== undefined
              ? yield* materializeAttachmentsForProjection({
                  attachments: payloadAttachments,
                })
              : previousMessage?.attachments;
          yield* projectionThreadMessageRepository.upsert({
            messageId: event.payload.messageId,
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            role,
            text: nextText,
            ...(nextAttachments !== undefined ? { attachments: [...nextAttachments] } : {}),
            ...(threadMessageAttribution(event.payload) !== undefined
              ? { attribution: threadMessageAttribution(event.payload) }
              : previousMessage?.attribution !== undefined
                ? { attribution: previousMessage.attribution }
                : {}),
            isStreaming: event.payload.streaming,
            createdAt: previousMessage?.createdAt ?? event.payload.createdAt,
            updatedAt: threadMessageUpdatedAt(event.payload),
          });
          return;
        }

        case "thread.reverted": {
          const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionMessagesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadMessageRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadMessageRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          attachmentSideEffects.prunedThreadRelativePaths.set(
            event.payload.threadId,
            collectThreadAttachmentRelativePaths(event.payload.threadId, keptRows),
          );
          return;
        }

        default:
          return;
      }
    });

    const applyThreadProposedPlansProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadProposedPlansProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.proposed-plan-upserted":
          yield* projectionThreadProposedPlanRepository.upsert({
            planId: event.payload.proposedPlan.id,
            threadId: event.payload.threadId,
            turnId: event.payload.proposedPlan.turnId,
            planMarkdown: event.payload.proposedPlan.planMarkdown,
            implementedAt: event.payload.proposedPlan.implementedAt,
            implementationThreadId: event.payload.proposedPlan.implementationThreadId,
            createdAt: event.payload.proposedPlan.createdAt,
            updatedAt: event.payload.proposedPlan.updatedAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadProposedPlanRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionProposedPlansAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadProposedPlanRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadProposedPlanRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadActivitiesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadActivitiesProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.activity-appended":
          yield* projectionThreadActivityRepository.upsert({
            activityId: event.payload.activity.id,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            tone: event.payload.activity.tone,
            kind: event.payload.activity.kind,
            summary: event.payload.activity.summary,
            payload: event.payload.activity.payload,
            ...(event.payload.activity.sequence !== undefined
              ? { sequence: event.payload.activity.sequence }
              : {}),
            createdAt: event.payload.activity.createdAt,
          });
          return;

        case "thread.activity-inline-diff-upserted": {
          const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const existingRow = existingRows.find(
            (row) => row.activityId === event.payload.activityId,
          );
          if (!existingRow) {
            return;
          }
          const payload =
            typeof existingRow.payload === "object" && existingRow.payload !== null
              ? existingRow.payload
              : {};
          yield* projectionThreadActivityRepository.upsert({
            ...existingRow,
            payload: {
              ...payload,
              inlineDiff: event.payload.inlineDiff,
            },
          });
          return;
        }

        case "thread.reverted": {
          const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionActivitiesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }
          yield* projectionThreadActivityRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadActivityRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadSessionsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadSessionsProjection",
    )(function* (event, _attachmentSideEffects) {
      if (event.type !== "thread.session-set") {
        return;
      }
      yield* projectionThreadSessionRepository.upsert({
        threadId: event.payload.threadId,
        status: event.payload.session.status,
        providerName: event.payload.session.providerName,
        runtimeMode: event.payload.session.runtimeMode,
        activeTurnId: event.payload.session.activeTurnId,
        lastError: event.payload.session.lastError,
        updatedAt: event.payload.session.updatedAt,
      });
    });

    const applyThreadTurnsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadTurnsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.turn-start-requested": {
          yield* projectionTurnRepository.replacePendingTurnStart({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            sourceProposedPlanThreadId: event.payload.sourceProposedPlan?.threadId ?? null,
            sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
            requestedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.turn-started": {
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state:
                existingTurn.value.state === "completed" || existingTurn.value.state === "error"
                  ? existingTurn.value.state
                  : "running",
              startedAt: existingTurn.value.startedAt ?? event.payload.startedAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.startedAt,
              completedAt: null,
            });
          } else {
            yield* projectionTurnRepository.upsertByTurnId({
              turnId: event.payload.turnId,
              threadId: event.payload.threadId,
              pendingMessageId: null,
              sourceProposedPlanThreadId: null,
              sourceProposedPlanId: null,
              assistantMessageId: null,
              state: "running",
              requestedAt: event.payload.startedAt,
              startedAt: event.payload.startedAt,
              completedAt: null,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
            });
          }

          yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          return;
        }

        case "thread.turn-completed": {
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: existingTurn.value.state === "error" ? "error" : "completed",
              startedAt: existingTurn.value.startedAt ?? event.payload.completedAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.completedAt,
              completedAt: event.payload.completedAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: null,
            state: "completed",
            requestedAt: event.payload.completedAt,
            startedAt: event.payload.completedAt,
            completedAt: event.payload.completedAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.session-set": {
          const turnId = event.payload.session.activeTurnId;
          if (turnId === null || event.payload.session.status !== "running") {
            return;
          }

          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId,
          });
          const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          if (Option.isSome(existingTurn)) {
            const nextState =
              existingTurn.value.state === "completed" || existingTurn.value.state === "error"
                ? existingTurn.value.state
                : "running";
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: nextState,
              pendingMessageId:
                existingTurn.value.pendingMessageId ??
                (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.messageId : null),
              sourceProposedPlanThreadId:
                existingTurn.value.sourceProposedPlanThreadId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanThreadId
                  : null),
              sourceProposedPlanId:
                existingTurn.value.sourceProposedPlanId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanId
                  : null),
              startedAt:
                existingTurn.value.startedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
              requestedAt:
                existingTurn.value.requestedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
            });
          } else {
            yield* projectionTurnRepository.upsertByTurnId({
              turnId,
              threadId: event.payload.threadId,
              pendingMessageId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.messageId
                : null,
              sourceProposedPlanThreadId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanThreadId
                : null,
              sourceProposedPlanId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanId
                : null,
              assistantMessageId: null,
              state: "running",
              requestedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              startedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              completedAt: null,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
            });
          }

          yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          return;
        }

        case "thread.message-sent": {
          if (event.payload.turnId === null || event.payload.role !== "assistant") {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.messageId,
              state: event.payload.streaming
                ? existingTurn.value.state
                : existingTurn.value.state === "interrupted"
                  ? "interrupted"
                  : existingTurn.value.state === "error"
                    ? "error"
                    : "completed",
              completedAt: event.payload.streaming
                ? existingTurn.value.completedAt
                : (existingTurn.value.completedAt ?? threadMessageUpdatedAt(event.payload)),
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.messageId,
            state: event.payload.streaming ? "running" : "completed",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.streaming ? null : threadMessageUpdatedAt(event.payload),
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-interrupt-requested": {
          if (event.payload.turnId === undefined) {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: "interrupted",
              completedAt: existingTurn.value.completedAt ?? event.payload.createdAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: null,
            state: "interrupted",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.createdAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-diff-completed": {
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          const nextState = event.payload.status === "error" ? "error" : "completed";
          yield* projectionTurnRepository.clearCheckpointTurnConflict({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
          });

          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.assistantMessageId,
              state: nextState,
              checkpointTurnCount: event.payload.checkpointTurnCount,
              checkpointRef: event.payload.checkpointRef,
              checkpointStatus: event.payload.status,
              checkpointFiles: event.payload.files,
              startedAt: existingTurn.value.startedAt ?? event.payload.completedAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.completedAt,
              completedAt: event.payload.completedAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.assistantMessageId,
            state: nextState,
            requestedAt: event.payload.completedAt,
            startedAt: event.payload.completedAt,
            completedAt: event.payload.completedAt,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointStatus: event.payload.status,
            checkpointFiles: event.payload.files,
          });
          return;
        }

        case "thread.checkpoint-captured": {
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          yield* projectionTurnRepository.clearCheckpointTurnConflict({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.turnCount,
          });

          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: existingTurn.value.state === "error" ? "error" : "completed",
              checkpointTurnCount: event.payload.turnCount,
              checkpointRef: CheckpointRef.makeUnsafe(event.payload.ref),
              checkpointStatus: "ready",
              startedAt: existingTurn.value.startedAt ?? event.payload.capturedAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.capturedAt,
              completedAt: event.payload.capturedAt,
            });
            return;
          }

          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: null,
            state: "completed",
            requestedAt: event.payload.capturedAt,
            startedAt: event.payload.capturedAt,
            completedAt: event.payload.capturedAt,
            checkpointTurnCount: event.payload.turnCount,
            checkpointRef: CheckpointRef.makeUnsafe(event.payload.ref),
            checkpointStatus: "ready",
            checkpointFiles: [],
          });
          return;
        }

        case "thread.checkpoint-reverted": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptTurns = existingTurns.filter(
            (turn) =>
              turn.turnId !== null &&
              turn.checkpointTurnCount !== null &&
              turn.checkpointTurnCount <= event.payload.turnCount,
          );
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            keptTurns,
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                  }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          return;
        }

        case "thread.reverted": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptTurns = existingTurns.filter(
            (turn) =>
              turn.turnId !== null &&
              turn.checkpointTurnCount !== null &&
              turn.checkpointTurnCount <= event.payload.turnCount,
          );
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            keptTurns,
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                  }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyCheckpointsProjection: ProjectorDefinition["apply"] = () => Effect.void;

    const applyAgentDiffsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyAgentDiffsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.agent-diff-upserted": {
          const existingAgentDiff = yield* projectionAgentDiffRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          yield* projectionAgentDiffRepository.upsert({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            diff: event.payload.diff,
            files: event.payload.files,
            source: event.payload.source,
            coverage: event.payload.coverage,
            assistantMessageId:
              event.payload.assistantMessageId ??
              Option.getOrUndefined(existingAgentDiff)?.assistantMessageId ??
              null,
            completedAt: event.payload.completedAt,
          });
          return;
        }

        case "thread.message-sent": {
          if (event.payload.role !== "assistant" || event.payload.turnId === null) {
            return;
          }
          const existingAgentDiff = yield* projectionAgentDiffRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isNone(existingAgentDiff)) {
            return;
          }
          yield* projectionAgentDiffRepository.upsert({
            ...existingAgentDiff.value,
            assistantMessageId: event.payload.messageId,
          });
          return;
        }

        case "thread.reverted": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const retainedTurnIds = new Set(
            existingTurns
              .filter(
                (turn) =>
                  turn.turnId !== null &&
                  turn.checkpointTurnCount !== null &&
                  turn.checkpointTurnCount <= event.payload.turnCount,
              )
              .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
          );
          const existingRows = yield* projectionAgentDiffRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          yield* projectionAgentDiffRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            existingRows.filter((row) => retainedTurnIds.has(row.turnId)),
            (row) => projectionAgentDiffRepository.upsert(row),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          return;
        }

        case "thread.deleted":
          yield* projectionAgentDiffRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          return;

        default:
          return;
      }
    });

    const applyPendingApprovalsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyPendingApprovalsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.activity-appended": {
          const requestId =
            extractActivityRequestId(event.payload.activity.payload) ??
            (event.metadata.requestId === undefined
              ? null
              : toPendingApprovalRequestId(event.metadata.requestId)) ??
            null;
          if (requestId === null) {
            return;
          }
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId,
          });
          if (event.payload.activity.kind === "approval.resolved") {
            const resolvedDecisionRaw =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null &&
              "decision" in event.payload.activity.payload
                ? (event.payload.activity.payload as { decision?: unknown }).decision
                : null;
            const resolvedDecision =
              resolvedDecisionRaw === "accept" ||
              resolvedDecisionRaw === "acceptForSession" ||
              resolvedDecisionRaw === "decline" ||
              resolvedDecisionRaw === "cancel"
                ? resolvedDecisionRaw
                : null;
            yield* projectionPendingApprovalRepository.upsert({
              requestId,
              threadId: Option.isSome(existingRow)
                ? existingRow.value.threadId
                : event.payload.threadId,
              turnId: Option.isSome(existingRow)
                ? existingRow.value.turnId
                : event.payload.activity.turnId,
              status: "resolved",
              decision: resolvedDecision,
              createdAt: Option.isSome(existingRow)
                ? existingRow.value.createdAt
                : event.payload.activity.createdAt,
              resolvedAt: event.payload.activity.createdAt,
            });
            return;
          }
          if (Option.isSome(existingRow) && existingRow.value.status === "resolved") {
            return;
          }
          yield* projectionPendingApprovalRepository.upsert({
            requestId,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            status: "pending",
            decision: null,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.activity.createdAt,
            resolvedAt: null,
          });
          return;
        }

        case "thread.interactive-request-response-requested": {
          if (!("decision" in event.payload.resolution)) {
            return;
          }
          const decision = event.payload.resolution.decision;
          if (
            decision !== "accept" &&
            decision !== "acceptForSession" &&
            decision !== "decline" &&
            decision !== "cancel"
          ) {
            return;
          }
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId: ApprovalRequestId.makeUnsafe(String(event.payload.requestId)),
          });
          yield* projectionPendingApprovalRepository.upsert({
            requestId: ApprovalRequestId.makeUnsafe(String(event.payload.requestId)),
            threadId: Option.isSome(existingRow)
              ? existingRow.value.threadId
              : event.payload.threadId,
            turnId: Option.isSome(existingRow) ? existingRow.value.turnId : null,
            status: "resolved",
            decision,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.createdAt,
            resolvedAt: event.payload.createdAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const projectors: ReadonlyArray<ProjectorDefinition> = [
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.projects,
        apply: applyProjectsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.phaseRuns,
        apply: applyPhaseRunsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.channels,
        apply: applyChannelsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.channelMessages,
        apply: applyChannelMessagesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.channelReads,
        apply: applyChannelReadsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.phaseOutputs,
        apply: applyPhaseOutputsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
        apply: applyThreadMessagesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
        apply: applyThreadProposedPlansProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
        apply: applyThreadActivitiesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
        apply: applyThreadSessionsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
        apply: applyThreadTurnsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
        apply: applyCheckpointsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.agentDiffs,
        apply: applyAgentDiffsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
        apply: applyPendingApprovalsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.interactiveRequests,
        apply: applyInteractiveRequestsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threads,
        apply: applyThreadsProjection,
      },
    ];

    const runProjectorForEvent = Effect.fn("runProjectorForEvent")(function* (
      projector: ProjectorDefinition,
      event: ForgeEvent,
    ) {
      const attachmentSideEffects: AttachmentSideEffects = {
        deletedThreadIds: new Set<string>(),
        prunedThreadRelativePaths: new Map<string, Set<string>>(),
      };

      yield* sql.withTransaction(
        projector.apply(event, attachmentSideEffects).pipe(
          Effect.flatMap(() =>
            projectionStateRepository.upsert({
              projector: projector.name,
              lastAppliedSequence: event.sequence,
              updatedAt: event.occurredAt,
            }),
          ),
        ),
      );

      yield* runAttachmentSideEffects(attachmentSideEffects).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to apply projected attachment side-effects", {
            projector: projector.name,
            sequence: event.sequence,
            eventType: event.type,
            cause,
          }),
        ),
      );
    });

    const bootstrapProjector = (projector: ProjectorDefinition) =>
      projectionStateRepository
        .getByProjector({
          projector: projector.name,
        })
        .pipe(
          Effect.flatMap((stateRow) =>
            Stream.runForEach(
              eventStore.readFromSequence(
                Option.isSome(stateRow) ? stateRow.value.lastAppliedSequence : 0,
              ),
              (event) => runProjectorForEvent(projector, event),
            ),
          ),
        );

    const projectEvent: OrchestrationProjectionPipelineShape["projectEvent"] = (event) =>
      Effect.forEach(projectors, (projector) => runProjectorForEvent(projector, event), {
        concurrency: 1,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ServerConfig, serverConfig),
        Effect.asVoid,
        Effect.catchTag("SqlError", (sqlError) =>
          Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectEvent:query")(sqlError)),
        ),
      );

    const bootstrap: OrchestrationProjectionPipelineShape["bootstrap"] = Effect.forEach(
      projectors,
      bootstrapProjector,
      { concurrency: 1 },
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.asVoid,
      Effect.tap(() =>
        Effect.logDebug("orchestration projection pipeline bootstrapped").pipe(
          Effect.annotateLogs({ projectors: projectors.length }),
        ),
      ),
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.bootstrap:query")(sqlError)),
      ),
    );

    return {
      bootstrap,
      projectEvent,
    } satisfies OrchestrationProjectionPipelineShape;
  },
);

export const OrchestrationProjectionPipelineLive = Layer.effect(
  OrchestrationProjectionPipeline,
  makeOrchestrationProjectionPipeline(),
).pipe(
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionPhaseRunRepositoryLive),
  Layer.provideMerge(ProjectionChannelRepositoryLive),
  Layer.provideMerge(ProjectionChannelMessageRepositoryLive),
  Layer.provideMerge(ProjectionChannelReadRepositoryLive),
  Layer.provideMerge(ProjectionPhaseOutputRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionAgentDiffRepositoryLive),
  Layer.provideMerge(ProjectionPendingApprovalRepositoryLive),
  Layer.provideMerge(ProjectionInteractiveRequestRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
);
