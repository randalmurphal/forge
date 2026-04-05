import type {
  Channel,
  ForgeEvent,
  GateResult,
  OrchestrationReadModel,
  PhaseOutputEntry,
  PhaseRunStatus,
  PhaseType,
  QualityCheckReference,
  QualityCheckResult,
  ThreadId,
  WorkflowId,
} from "@t3tools/contracts";
import {
  ChannelId,
  ChannelMessageId,
  LinkId,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
  PhaseRunId,
  WorkflowPhaseId,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";

import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from "./Errors.ts";
import {
  MessageSentPayloadSchema,
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
  ThreadActivityAppendedPayload,
  ThreadArchivedPayload,
  ThreadBootstrapCompletedPayload,
  ThreadBootstrapFailedPayload,
  ThreadBootstrapSkippedPayload,
  ThreadBootstrapStartedPayload,
  ChannelClosedPayload,
  ChannelConclusionProposedPayload,
  ChannelConcludedPayload,
  ChannelCreatedPayload,
  ChannelMessagePostedPayload,
  ChannelMessagesReadPayload,
  InteractiveRequestOpenedPayload,
  InteractiveRequestResolvedPayload,
  InteractiveRequestStalePayload,
  ThreadCorrectionDeliveredPayload,
  ThreadCorrectionQueuedPayload,
  ThreadCreatedPayload,
  ThreadDependenciesSatisfiedPayload,
  ThreadDependencyAddedPayload,
  ThreadDependencyRemovedPayload,
  ThreadDeletedPayload,
  ThreadInteractionModeSetPayload,
  ThreadLinkAddedPayload,
  ThreadLinkRemovedPayload,
  ThreadMetaUpdatedPayload,
  ThreadPhaseCompletedPayload,
  ThreadPhaseFailedPayload,
  ThreadPhaseOutputEditedPayload,
  ThreadPhaseSkippedPayload,
  ThreadPhaseStartedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadPromotedPayload,
  ThreadQualityCheckCompletedPayload,
  ThreadQualityCheckStartedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadSynthesisCompletedPayload,
  ThreadUnarchivedPayload,
  ThreadRevertedPayload,
  ThreadSessionSetPayload,
  ThreadTurnDiffCompletedPayload,
} from "./Schemas.ts";

type ProjectedPhaseRun = {
  readonly phaseRunId: PhaseRunId;
  readonly threadId: ThreadId;
  readonly phaseId: WorkflowPhaseId;
  readonly phaseName: string;
  readonly phaseType: PhaseType;
  readonly iteration: number;
  readonly status: PhaseRunStatus;
  readonly outputs: ReadonlyArray<PhaseOutputEntry>;
  readonly gateResult: GateResult | null;
  readonly qualityCheckReferences: ReadonlyArray<QualityCheckReference> | null;
  readonly qualityCheckResults: ReadonlyArray<QualityCheckResult> | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly failure: string | null;
};

type ProjectedThreadLink = {
  readonly threadId: ThreadId;
  readonly linkId: LinkId;
  readonly linkType: string;
  readonly linkedThreadId: ThreadId | null;
  readonly externalId: string | null;
  readonly externalUrl: string | null;
  readonly createdAt: string;
};

type ProjectedThreadDependency = {
  readonly threadId: ThreadId;
  readonly dependsOnThreadId: ThreadId;
  readonly createdAt: string;
  readonly satisfiedAt: string | null;
};

type ProjectedCorrection = {
  readonly threadId: ThreadId;
  readonly content: string;
  readonly channelId: ChannelId;
  readonly messageId: ChannelMessageId;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
};

type ProjectedSynthesis = {
  readonly threadId: ThreadId;
  readonly content: string;
  readonly generatedByThreadId: ThreadId;
  readonly completedAt: string;
};

type ProjectedThread = OrchestrationThread & {
  readonly parentThreadId: ThreadId | null;
  readonly phaseRunId: PhaseRunId | null;
  readonly workflowId: WorkflowId | null;
  readonly currentPhaseId: WorkflowPhaseId | null;
  readonly patternId: string | null;
  readonly role: string | null;
  readonly childThreadIds: ReadonlyArray<ThreadId>;
  readonly bootstrapStatus: string | null;
};

type ProjectedReadModel = OrchestrationReadModel & {
  readonly threads: ReadonlyArray<ProjectedThread>;
  readonly phaseRuns: ReadonlyArray<ProjectedPhaseRun>;
  readonly workflows: ReadonlyArray<{
    readonly workflowId: WorkflowId;
    readonly name: string;
    readonly description: string;
    readonly builtIn: boolean;
  }>;
  readonly threadLinks: ReadonlyArray<ProjectedThreadLink>;
  readonly threadDependencies: ReadonlyArray<ProjectedThreadDependency>;
  readonly corrections: ReadonlyArray<ProjectedCorrection>;
  readonly synthesis: ReadonlyArray<ProjectedSynthesis>;
};

type ThreadPatch = Partial<Omit<ProjectedThread, "id" | "projectId">>;
const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_CHECKPOINTS = 500;

function toProjectedThread(thread: OrchestrationThread): ProjectedThread {
  const projected = thread as Partial<ProjectedThread>;
  return {
    ...thread,
    parentThreadId: projected.parentThreadId ?? null,
    phaseRunId: projected.phaseRunId ?? null,
    workflowId: projected.workflowId ?? null,
    currentPhaseId: projected.currentPhaseId ?? null,
    patternId: projected.patternId ?? null,
    role: projected.role ?? null,
    childThreadIds: projected.childThreadIds ?? [],
    bootstrapStatus: projected.bootstrapStatus ?? null,
  };
}

function toProjectedReadModel(model: OrchestrationReadModel): ProjectedReadModel {
  const projected = model as Partial<ProjectedReadModel>;
  return {
    ...model,
    threads: model.threads.map(toProjectedThread),
    phaseRuns: (projected.phaseRuns as ReadonlyArray<ProjectedPhaseRun> | undefined) ?? [],
    workflows: projected.workflows ?? [],
    threadLinks: projected.threadLinks ?? [],
    threadDependencies: projected.threadDependencies ?? [],
    corrections: projected.corrections ?? [],
    synthesis: projected.synthesis ?? [],
  };
}

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") return "error" as const;
  if (status === "missing") return "interrupted" as const;
  return "completed" as const;
}

function updateThread(
  threads: ReadonlyArray<ProjectedThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): ProjectedThread[] {
  return threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread));
}

function decodeForEvent<A>(
  schema: Schema.Schema<A>,
  value: unknown,
  eventType: ForgeEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema as any)(value),
    catch: (error) => toProjectorDecodeError(`${eventType}:${field}`)(error as Schema.SchemaError),
  });
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<OrchestrationThread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["proposedPlans"][number]> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function upsertPhaseRun(
  phaseRuns: ReadonlyArray<ProjectedPhaseRun>,
  phaseRun: ProjectedPhaseRun,
): ReadonlyArray<ProjectedPhaseRun> {
  const nextPhaseRuns = [
    ...phaseRuns.filter((entry) => entry.phaseRunId !== phaseRun.phaseRunId),
    phaseRun,
  ];

  return nextPhaseRuns.toSorted(
    (left, right) =>
      (left.startedAt ?? "").localeCompare(right.startedAt ?? "") ||
      left.iteration - right.iteration ||
      left.phaseName.localeCompare(right.phaseName) ||
      left.phaseRunId.localeCompare(right.phaseRunId),
  );
}

function updatePhaseRun(
  phaseRuns: ReadonlyArray<ProjectedPhaseRun>,
  phaseRunId: PhaseRunId,
  patch: Partial<ProjectedPhaseRun>,
): ReadonlyArray<ProjectedPhaseRun> {
  return phaseRuns.map((phaseRun) =>
    phaseRun.phaseRunId === phaseRunId ? { ...phaseRun, ...patch } : phaseRun,
  );
}

function upsertChannel(channels: ReadonlyArray<Channel>, channel: Channel): ReadonlyArray<Channel> {
  return [...channels.filter((entry) => entry.id !== channel.id), channel].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    phaseRuns: [],
    channels: [],
    pendingRequests: [],
    workflows: [],
    threadLinks: [],
    threadDependencies: [],
    corrections: [],
    synthesis: [],
    updatedAt: nowIso,
  } as OrchestrationReadModel;
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: ForgeEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const nextBase: ProjectedReadModel = {
    ...toProjectedReadModel(model),
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "project.created":
      return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.projects.find((entry) => entry.id === payload.projectId);
          const nextProject = {
            id: payload.projectId,
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
            defaultModelSelection: payload.defaultModelSelection,
            scripts: payload.scripts,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };

          return {
            ...nextBase,
            projects: existing
              ? nextBase.projects.map((entry) =>
                  entry.id === payload.projectId ? nextProject : entry,
                )
              : [...nextBase.projects, nextProject],
          };
        }),
      );

    case "project.meta-updated":
      return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.workspaceRoot !== undefined
                    ? { workspaceRoot: payload.workspaceRoot }
                    : {}),
                  ...(payload.defaultModelSelection !== undefined
                    ? { defaultModelSelection: payload.defaultModelSelection }
                    : {}),
                  ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                  updatedAt: payload.updatedAt,
                }
              : project,
          ),
        })),
      );

    case "project.deleted":
      return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : project,
          ),
        })),
      );

    case "thread.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread: OrchestrationThread = yield* decodeForEvent(
          OrchestrationThread,
          {
            id: payload.threadId,
            projectId: payload.projectId,
            title: payload.title,
            modelSelection: payload.modelSelection,
            runtimeMode: payload.runtimeMode,
            interactionMode: payload.interactionMode,
            branch: payload.branch,
            worktreePath: payload.worktreePath,
            latestTurn: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            deletedAt: null,
            parentThreadId: null,
            phaseRunId: null,
            workflowId: null,
            currentPhaseId: null,
            patternId: null,
            role: null,
            childThreadIds: [],
            bootstrapStatus: null,
            messages: [],
            activities: [],
            checkpoints: [],
            session: null,
          },
          event.type,
          "thread",
        );
        const projectedThread = toProjectedThread(thread);
        const existing = nextBase.threads.find((entry) => entry.id === thread.id);
        return {
          ...nextBase,
          threads: existing
            ? nextBase.threads.map((entry) => (entry.id === thread.id ? projectedThread : entry))
            : [...nextBase.threads, projectedThread],
        };
      });

    case "thread.deleted":
      return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            deletedAt: payload.deletedAt,
            updatedAt: payload.deletedAt,
          }),
        })),
      );

    case "thread.archived":
      return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: payload.archivedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unarchived":
      return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.meta-updated":
      return decodeForEvent(ThreadMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.modelSelection !== undefined
              ? { modelSelection: payload.modelSelection }
              : {}),
            ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
            ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.runtime-mode-set":
      return decodeForEvent(ThreadRuntimeModeSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            runtimeMode: payload.runtimeMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.interaction-mode-set":
      return decodeForEvent(
        ThreadInteractionModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            interactionMode: payload.interactionMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.message-sent":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          MessageSentPayloadSchema,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            role: payload.role,
            text: payload.text,
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            turnId: payload.turnId,
            streaming: payload.streaming,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
          event.type,
          "message",
        );

        const existingMessage = thread.messages.find((entry) => entry.id === message.id);
        const messages = existingMessage
          ? thread.messages.map((entry) =>
              entry.id === message.id
                ? {
                    ...entry,
                    text: message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                    streaming: message.streaming,
                    updatedAt: message.updatedAt,
                    turnId: message.turnId,
                    ...(message.attachments !== undefined
                      ? { attachments: message.attachments }
                      : {}),
                  }
                : entry,
            )
          : [...thread.messages, message];
        const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: cappedMessages,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.session-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadSessionSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const session: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          "session",
        );

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            session,
            latestTurn:
              session.status === "running" && session.activeTurnId !== null
                ? {
                    turnId: session.activeTurnId,
                    state: "running",
                    requestedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.requestedAt
                        : session.updatedAt,
                    startedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? (thread.latestTurn.startedAt ?? session.updatedAt)
                        : session.updatedAt,
                    completedAt: null,
                    assistantMessageId:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.assistantMessageId
                        : null,
                  }
                : thread.latestTurn,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.proposed-plan-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadProposedPlanUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
          payload.proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-200);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            proposedPlans,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-diff-completed":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnDiffCompletedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const checkpoint = yield* decodeForEvent(
          OrchestrationCheckpointSummary,
          {
            turnId: payload.turnId,
            checkpointTurnCount: payload.checkpointTurnCount,
            checkpointRef: payload.checkpointRef,
            status: payload.status,
            files: payload.files,
            assistantMessageId: payload.assistantMessageId,
            completedAt: payload.completedAt,
          },
          event.type,
          "checkpoint",
        );

        // Do not let a placeholder (status "missing") overwrite a checkpoint
        // that has already been captured with a real git ref (status "ready").
        // ProviderRuntimeIngestion may fire multiple turn.diff.updated events
        // per turn; without this guard later placeholders would clobber the
        // real capture dispatched by CheckpointReactor.
        const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return nextBase;
        }

        const checkpoints = [
          ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
          .slice(-MAX_THREAD_CHECKPOINTS);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            checkpoints,
            latestTurn: {
              turnId: payload.turnId,
              state: checkpointStatusToLatestTurnState(payload.status),
              requestedAt:
                thread.latestTurn?.turnId === payload.turnId
                  ? thread.latestTurn.requestedAt
                  : payload.completedAt,
              startedAt:
                thread.latestTurn?.turnId === payload.turnId
                  ? (thread.latestTurn.startedAt ?? payload.completedAt)
                  : payload.completedAt,
              completedAt: payload.completedAt,
              assistantMessageId: payload.assistantMessageId,
            },
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.reverted":
      return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId) as
            | ProjectedThread
            | undefined;
          if (!thread) {
            return nextBase;
          }

          const checkpoints = thread.checkpoints
            .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);
          const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          ).slice(-200);
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);

          const latestCheckpoint = checkpoints.at(-1) ?? null;
          const latestTurn =
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId,
                };

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages,
              proposedPlans,
              activities,
              latestTurn,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId) as
            | ProjectedThread
            | undefined;
          if (!thread) {
            return nextBase;
          }

          const activities = [
            ...thread.activities.filter((entry) => entry.id !== payload.activity.id),
            payload.activity,
          ]
            .toSorted(compareThreadActivities)
            .slice(-500);

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.phase-started":
      return decodeForEvent(ThreadPhaseStartedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId) as
            | ProjectedThread
            | undefined;
          if (!thread) {
            return nextBase;
          }

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              phaseRunId: payload.phaseRunId,
              currentPhaseId: payload.phaseId,
              updatedAt: payload.startedAt,
            }),
            phaseRuns: upsertPhaseRun(nextBase.phaseRuns, {
              phaseRunId: payload.phaseRunId,
              threadId: payload.threadId,
              phaseId: payload.phaseId,
              phaseName: payload.phaseName,
              phaseType: payload.phaseType,
              iteration: payload.iteration,
              status: "running",
              outputs: [],
              gateResult: null,
              qualityCheckReferences: null,
              qualityCheckResults: null,
              startedAt: payload.startedAt,
              completedAt: null,
              failure: null,
            }),
          };
        }),
      );

    case "thread.phase-completed":
      return decodeForEvent(ThreadPhaseCompletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread: ProjectedThread | undefined = nextBase.threads.find(
            (entry) => entry.id === payload.threadId,
          ) as ProjectedThread | undefined;
          const existing = nextBase.phaseRuns.find(
            (entry) => entry.phaseRunId === payload.phaseRunId,
          );
          if (!thread || !existing) {
            return nextBase;
          }

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              phaseRunId: null,
              currentPhaseId:
                thread.phaseRunId === payload.phaseRunId ? null : thread.currentPhaseId,
              updatedAt: payload.completedAt,
            }),
            phaseRuns: updatePhaseRun(nextBase.phaseRuns, payload.phaseRunId, {
              status: "completed",
              outputs: payload.outputs,
              gateResult: payload.gateResult ?? null,
              completedAt: payload.completedAt,
              failure: null,
            }),
          };
        }),
      );

    case "thread.phase-failed":
      return decodeForEvent(ThreadPhaseFailedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread: ProjectedThread | undefined = nextBase.threads.find(
            (entry) => entry.id === payload.threadId,
          ) as ProjectedThread | undefined;
          const existing = nextBase.phaseRuns.find(
            (entry) => entry.phaseRunId === payload.phaseRunId,
          );
          if (!thread || !existing) {
            return nextBase;
          }

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              phaseRunId: thread.phaseRunId === payload.phaseRunId ? null : thread.phaseRunId,
              currentPhaseId:
                thread.phaseRunId === payload.phaseRunId ? null : thread.currentPhaseId,
              updatedAt: payload.failedAt,
            }),
            phaseRuns: updatePhaseRun(nextBase.phaseRuns, payload.phaseRunId, {
              status: "failed",
              completedAt: payload.failedAt,
              failure: payload.error,
            }),
          };
        }),
      );

    case "thread.phase-skipped":
      return decodeForEvent(ThreadPhaseSkippedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread: ProjectedThread | undefined = nextBase.threads.find(
            (entry) => entry.id === payload.threadId,
          ) as ProjectedThread | undefined;
          const existing = nextBase.phaseRuns.find(
            (entry) => entry.phaseRunId === payload.phaseRunId,
          );
          if (!thread || !existing) {
            return nextBase;
          }

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              phaseRunId: thread.phaseRunId === payload.phaseRunId ? null : thread.phaseRunId,
              currentPhaseId:
                thread.phaseRunId === payload.phaseRunId ? null : thread.currentPhaseId,
              updatedAt: payload.skippedAt,
            }),
            phaseRuns: updatePhaseRun(nextBase.phaseRuns, payload.phaseRunId, {
              status: "skipped",
              completedAt: payload.skippedAt,
              failure: null,
            }),
          };
        }),
      );

    case "thread.phase-output-edited":
      return decodeForEvent(
        ThreadPhaseOutputEditedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const phaseRun = nextBase.phaseRuns.find(
            (entry) => entry.phaseRunId === payload.phaseRunId,
          ) as ProjectedPhaseRun | undefined;
          if (!phaseRun) {
            return nextBase;
          }

          const outputs = phaseRun.outputs.some((entry) => entry.key === payload.outputKey)
            ? phaseRun.outputs.map((entry) =>
                entry.key === payload.outputKey ? { ...entry, content: payload.newContent } : entry,
              )
            : [
                ...phaseRun.outputs,
                {
                  key: payload.outputKey,
                  content: payload.newContent,
                  sourceType: "human",
                } as const,
              ];

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              updatedAt: payload.editedAt,
            }),
            phaseRuns: updatePhaseRun(nextBase.phaseRuns, payload.phaseRunId, {
              outputs,
            }),
          };
        }),
      );

    case "thread.quality-check-started":
      return decodeForEvent(
        ThreadQualityCheckStartedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          phaseRuns: updatePhaseRun(nextBase.phaseRuns, payload.phaseRunId, {
            qualityCheckReferences: payload.checks,
            qualityCheckResults: null,
          }),
          threads: updateThread(nextBase.threads, payload.threadId, {
            updatedAt: payload.startedAt,
          }),
        })),
      );

    case "thread.quality-check-completed":
      return decodeForEvent(
        ThreadQualityCheckCompletedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          phaseRuns: updatePhaseRun(nextBase.phaseRuns, payload.phaseRunId, {
            qualityCheckResults: payload.results,
          }),
          threads: updateThread(nextBase.threads, payload.threadId, {
            updatedAt: payload.completedAt,
          }),
        })),
      );

    case "thread.bootstrap-started":
      return decodeForEvent(
        ThreadBootstrapStartedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            bootstrapStatus: "running",
            updatedAt: payload.startedAt,
          }),
        })),
      );

    case "thread.bootstrap-completed":
      return decodeForEvent(
        ThreadBootstrapCompletedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            bootstrapStatus: "completed",
            updatedAt: payload.completedAt,
          }),
        })),
      );

    case "thread.bootstrap-failed":
      return decodeForEvent(
        ThreadBootstrapFailedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            bootstrapStatus: "failed",
            updatedAt: payload.failedAt,
          }),
        })),
      );

    case "thread.bootstrap-skipped":
      return decodeForEvent(
        ThreadBootstrapSkippedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            bootstrapStatus: "skipped",
            updatedAt: payload.skippedAt,
          }),
        })),
      );

    case "thread.correction-queued":
      return decodeForEvent(
        ThreadCorrectionQueuedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            updatedAt: payload.createdAt,
          }),
          corrections: [
            ...nextBase.corrections.filter((entry) => entry.threadId !== payload.threadId),
            {
              threadId: payload.threadId,
              content: payload.content,
              channelId: payload.channelId,
              messageId: payload.messageId,
              createdAt: payload.createdAt,
              deliveredAt: null,
            },
          ],
        })),
      );

    case "thread.correction-delivered":
      return decodeForEvent(
        ThreadCorrectionDeliveredPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            updatedAt: payload.deliveredAt,
          }),
          corrections: nextBase.corrections.map((entry) =>
            entry.threadId === payload.threadId
              ? {
                  ...entry,
                  deliveredAt: payload.deliveredAt,
                }
              : entry,
          ),
        })),
      );

    case "thread.link-added":
      return decodeForEvent(ThreadLinkAddedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            updatedAt: payload.createdAt,
          }),
          threadLinks: [
            ...nextBase.threadLinks.filter((entry) => entry.linkId !== payload.linkId),
            {
              threadId: payload.threadId,
              linkId: payload.linkId,
              linkType: payload.linkType,
              linkedThreadId: payload.linkedThreadId,
              externalId: payload.externalId,
              externalUrl: payload.externalUrl,
              createdAt: payload.createdAt,
            },
          ],
        })),
      );

    case "thread.link-removed":
      return decodeForEvent(ThreadLinkRemovedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            updatedAt: payload.removedAt,
          }),
          threadLinks: nextBase.threadLinks.filter((entry) => entry.linkId !== payload.linkId),
        })),
      );

    case "thread.promoted":
      return decodeForEvent(ThreadPromotedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const sourceThread = nextBase.threads.find(
            (entry) => entry.id === payload.sourceThreadId,
          );
          const nextChildThreadIds =
            sourceThread === undefined ||
            sourceThread.childThreadIds.includes(payload.targetThreadId)
              ? (sourceThread?.childThreadIds ?? [])
              : [...sourceThread.childThreadIds, payload.targetThreadId];

          return {
            ...nextBase,
            threads: updateThread(
              updateThread(nextBase.threads, payload.sourceThreadId, {
                childThreadIds: nextChildThreadIds,
                updatedAt: payload.promotedAt,
              }),
              payload.targetThreadId,
              {
                parentThreadId: payload.sourceThreadId,
                updatedAt: payload.promotedAt,
              },
            ),
          };
        }),
      );

    case "channel.created":
      return decodeForEvent(ChannelCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          channels: upsertChannel(nextBase.channels, {
            id: payload.channelId,
            threadId: payload.threadId,
            ...(payload.phaseRunId === null ? {} : { phaseRunId: payload.phaseRunId }),
            type: payload.channelType,
            status: "open",
            createdAt: payload.createdAt,
            updatedAt: payload.createdAt,
          }),
          threads: updateThread(nextBase.threads, payload.threadId, {
            updatedAt: payload.createdAt,
          }),
        })),
      );

    case "channel.message-posted":
      return decodeForEvent(ChannelMessagePostedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const channel = nextBase.channels.find((entry) => entry.id === payload.channelId);
          if (!channel) {
            return nextBase;
          }

          return {
            ...nextBase,
            channels: upsertChannel(nextBase.channels, {
              ...channel,
              updatedAt: payload.createdAt,
            }),
            threads: updateThread(nextBase.threads, channel.threadId, {
              updatedAt: payload.createdAt,
            }),
          };
        }),
      );

    case "channel.messages-read":
      return decodeForEvent(ChannelMessagesReadPayload, event.payload, event.type, "payload").pipe(
        Effect.as(nextBase),
      );

    case "channel.conclusion-proposed":
      return decodeForEvent(
        ChannelConclusionProposedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const channel = nextBase.channels.find((entry) => entry.id === payload.channelId);
          if (!channel) {
            return nextBase;
          }

          return {
            ...nextBase,
            channels: upsertChannel(nextBase.channels, {
              ...channel,
              updatedAt: payload.proposedAt,
            }),
            threads: updateThread(nextBase.threads, payload.threadId, {
              updatedAt: payload.proposedAt,
            }),
          };
        }),
      );

    case "channel.concluded":
      return decodeForEvent(ChannelConcludedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const channel = nextBase.channels.find((entry) => entry.id === payload.channelId);
          if (!channel) {
            return nextBase;
          }

          return {
            ...nextBase,
            channels: upsertChannel(nextBase.channels, {
              ...channel,
              status: "concluded",
              updatedAt: payload.concludedAt,
            }),
            threads: updateThread(nextBase.threads, channel.threadId, {
              updatedAt: payload.concludedAt,
            }),
          };
        }),
      );

    case "channel.closed":
      return decodeForEvent(ChannelClosedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const channel = nextBase.channels.find((entry) => entry.id === payload.channelId);
          if (!channel) {
            return nextBase;
          }

          return {
            ...nextBase,
            channels: upsertChannel(nextBase.channels, {
              ...channel,
              status: "closed",
              updatedAt: payload.closedAt,
            }),
            threads: updateThread(nextBase.threads, channel.threadId, {
              updatedAt: payload.closedAt,
            }),
          };
        }),
      );

    case "request.opened":
      return decodeForEvent(
        InteractiveRequestOpenedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const pendingRequest: OrchestrationReadModel["pendingRequests"][number] = {
            id: payload.requestId,
            threadId: payload.threadId,
            ...(payload.childThreadId === null ? {} : { childThreadId: payload.childThreadId }),
            ...(payload.phaseRunId === null ? {} : { phaseRunId: payload.phaseRunId }),
            type: payload.requestType,
            status: "pending",
            payload: payload.payload,
            createdAt: payload.createdAt,
          };

          return {
            ...nextBase,
            pendingRequests: [
              ...nextBase.pendingRequests.filter((entry) => entry.id !== payload.requestId),
              pendingRequest,
            ].toSorted(
              (left, right) =>
                left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
            ),
            threads: updateThread(nextBase.threads, payload.threadId, {
              updatedAt: payload.createdAt,
            }),
          };
        }),
      );

    case "request.resolved":
      return decodeForEvent(
        InteractiveRequestResolvedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const request = nextBase.pendingRequests.find((entry) => entry.id === payload.requestId);
          if (!request) {
            return nextBase;
          }

          return {
            ...nextBase,
            pendingRequests: nextBase.pendingRequests.filter(
              (entry) => entry.id !== payload.requestId,
            ),
            threads: updateThread(nextBase.threads, request.threadId, {
              updatedAt: payload.resolvedAt,
            }),
          };
        }),
      );

    case "request.stale":
      return decodeForEvent(
        InteractiveRequestStalePayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const request = nextBase.pendingRequests.find((entry) => entry.id === payload.requestId);
          if (!request) {
            return nextBase;
          }

          return {
            ...nextBase,
            pendingRequests: nextBase.pendingRequests.filter(
              (entry) => entry.id !== payload.requestId,
            ),
            threads: updateThread(nextBase.threads, request.threadId, {
              updatedAt: payload.staleAt,
            }),
          };
        }),
      );

    case "thread.dependency-added":
      return decodeForEvent(
        ThreadDependencyAddedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            updatedAt: payload.createdAt,
          }),
          threadDependencies: [
            ...nextBase.threadDependencies.filter(
              (entry) =>
                !(
                  entry.threadId === payload.threadId &&
                  entry.dependsOnThreadId === payload.dependsOnThreadId
                ),
            ),
            {
              threadId: payload.threadId,
              dependsOnThreadId: payload.dependsOnThreadId,
              createdAt: payload.createdAt,
              satisfiedAt: null,
            },
          ],
        })),
      );

    case "thread.dependency-removed":
      return decodeForEvent(
        ThreadDependencyRemovedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            updatedAt: payload.removedAt,
          }),
          threadDependencies: nextBase.threadDependencies.filter(
            (entry) =>
              !(
                entry.threadId === payload.threadId &&
                entry.dependsOnThreadId === payload.dependsOnThreadId
              ),
          ),
        })),
      );

    case "thread.dependencies-satisfied":
      return decodeForEvent(
        ThreadDependenciesSatisfiedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            updatedAt: payload.satisfiedAt,
          }),
          threadDependencies: nextBase.threadDependencies.map((entry) =>
            entry.threadId === payload.threadId
              ? { ...entry, satisfiedAt: payload.satisfiedAt }
              : entry,
          ),
        })),
      );

    case "thread.synthesis-completed":
      return decodeForEvent(
        ThreadSynthesisCompletedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            updatedAt: payload.completedAt,
          }),
          synthesis: [
            ...nextBase.synthesis.filter((entry) => entry.threadId !== payload.threadId),
            {
              threadId: payload.threadId,
              content: payload.content,
              generatedByThreadId: payload.generatedByThreadId,
              completedAt: payload.completedAt,
            },
          ],
        })),
      );

    default:
      return Effect.succeed(nextBase);
  }
}
