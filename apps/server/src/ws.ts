import { Effect, Layer, Option, Queue, Ref, Schema, Stream } from "effect";
import {
  type Channel,
  type ChannelPushEvent,
  ForgeEvent,
  type ForgeEvent as ForgeEventEnvelope,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  OrchestrationReplayEventsError,
  type TerminalEvent,
  ThreadId,
  type WorkflowPushEvent,
  type WorkflowDefinition,
  workflowHasDeliberation,
  WS_METHODS,
  WsRpcGroup,
} from "@forgetools/contracts";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { ChannelService } from "./channel/Services/ChannelService.ts";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore";
import { GitManager } from "./git/Services/GitManager";
import { Keybindings } from "./keybindings";
import { Open, resolveAvailableEditors } from "./open";
import { normalizeDispatchCommand } from "./orchestration/Normalizer";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import {
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
} from "./observability/RpcInstrumentation";
import { ProjectionInteractiveRequestRepository } from "./persistence/Services/ProjectionInteractiveRequests.ts";
import { ProjectionPhaseOutputRepository } from "./persistence/Services/ProjectionPhaseOutputs.ts";
import { ProjectionPhaseRunRepository } from "./persistence/Services/ProjectionPhaseRuns.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessage,
} from "./persistence/Services/ProjectionThreadMessages.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "./persistence/Services/ProjectionThreads.ts";
import { ProjectionThreadSessionRepository } from "./persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionWorkflowRepository } from "./persistence/Services/ProjectionWorkflows.ts";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { deriveForgeSessionType } from "./sessionType";
import { TerminalManager } from "./terminal/Services/Manager";
import { DiscussionRegistry } from "./discussion/Services/DiscussionRegistry.ts";
import { WorkflowRegistry } from "./workflow/Services/WorkflowRegistry.ts";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem";
import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths";

type WorkflowPhaseInfo = Extract<WorkflowPushEvent, { channel: "workflow.phase" }>["phaseInfo"];
type WorkflowGateRequestState = {
  readonly threadId: Extract<WorkflowPushEvent, { channel: "workflow.gate" }>["threadId"];
  readonly phaseRunId: Extract<WorkflowPushEvent, { channel: "workflow.gate" }>["phaseRunId"];
  readonly gateType: "human-approval" | "quality-checks";
};
type WorkflowPushStreamState = {
  readonly phaseRunInfoById: Map<
    Extract<WorkflowPushEvent, { channel: "workflow.phase" }>["phaseRunId"],
    {
      readonly threadId: Extract<WorkflowPushEvent, { channel: "workflow.phase" }>["threadId"];
      readonly phaseInfo: WorkflowPhaseInfo;
    }
  >;
  readonly gateRequestsById: Map<string, WorkflowGateRequestState>;
};
type ChannelPushStreamState = {
  readonly ownerThreadIdByChannelId: Map<
    Extract<ChannelPushEvent, { channel: "channel.message" }>["channelId"],
    Extract<ChannelPushEvent, { channel: "channel.message" }>["threadId"]
  >;
};

function paginateEntries<T>(
  entries: ReadonlyArray<T>,
  offset?: number,
  limit?: number,
): ReadonlyArray<T> {
  const safeOffset = Math.max(0, offset ?? 0);
  const sliced = entries.slice(safeOffset);
  return limit === undefined ? sliced : sliced.slice(0, Math.max(0, limit));
}

function toTranscriptEntry(message: ProjectionThreadMessage) {
  return {
    id: message.messageId,
    role: message.role,
    text: message.text,
    ...(message.attachments ? { attachments: message.attachments } : {}),
    turnId: message.turnId,
    streaming: message.isStreaming,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

function deriveSessionType(thread: ProjectionThread) {
  return deriveForgeSessionType(thread);
}

function deriveSessionStatus(input: {
  readonly thread: ProjectionThread;
  readonly runtimeStatus: string | null;
  readonly hasPendingRequest: boolean;
}) {
  if (input.hasPendingRequest) {
    return "needs-attention" as const;
  }
  if (input.thread.completedAt !== null) {
    return "completed" as const;
  }
  switch (input.runtimeStatus) {
    case "starting":
    case "running":
      return "running" as const;
    case "interrupted":
      return "paused" as const;
    case "error":
      return "failed" as const;
    case "stopped":
      return "cancelled" as const;
    default:
      return "created" as const;
  }
}

function createWorkflowPushStreamState(snapshot: OrchestrationReadModel): WorkflowPushStreamState {
  return {
    phaseRunInfoById: new Map(
      snapshot.phaseRuns.map((phaseRun) => [
        phaseRun.phaseRunId,
        {
          threadId: phaseRun.threadId,
          phaseInfo: {
            phaseId: phaseRun.phaseId,
            phaseName: phaseRun.phaseName,
            phaseType: phaseRun.phaseType,
            iteration: phaseRun.iteration,
          },
        },
      ]),
    ),
    gateRequestsById: new Map(),
  };
}

function createChannelPushStreamState(snapshot: OrchestrationReadModel): ChannelPushStreamState {
  return {
    ownerThreadIdByChannelId: new Map(
      snapshot.channels.map((channel) => [channel.id, channel.threadId]),
    ),
  };
}

function toForgeEventEnvelope(event: OrchestrationEvent): ForgeEventEnvelope | null {
  return Schema.is(ForgeEvent)(event as unknown) ? (event as unknown as ForgeEventEnvelope) : null;
}

function toWorkflowGateType(value: string): "human-approval" | "quality-checks" | null {
  switch (value) {
    case "human-approval":
    case "quality-checks":
      return value;
    default:
      return null;
  }
}

function mapWorkflowPushEvents(
  state: WorkflowPushStreamState,
  event: ForgeEventEnvelope,
): {
  readonly state: WorkflowPushStreamState;
  readonly emit: Array<WorkflowPushEvent>;
} {
  switch (event.type) {
    case "thread.phase-started": {
      const phaseInfo: WorkflowPhaseInfo = {
        phaseId: event.payload.phaseId,
        phaseName: event.payload.phaseName,
        phaseType: event.payload.phaseType,
        iteration: event.payload.iteration,
      };

      return {
        state: {
          ...state,
          phaseRunInfoById: new Map(state.phaseRunInfoById).set(event.payload.phaseRunId, {
            threadId: event.payload.threadId,
            phaseInfo,
          }),
        },
        emit: [
          {
            channel: "workflow.phase",
            threadId: event.payload.threadId,
            phaseRunId: event.payload.phaseRunId,
            event: "started",
            phaseInfo,
            timestamp: event.payload.startedAt,
          },
        ],
      };
    }
    case "thread.phase-completed": {
      const phaseRun = state.phaseRunInfoById.get(event.payload.phaseRunId);
      if (!phaseRun) {
        return { state, emit: [] };
      }

      return {
        state,
        emit: [
          {
            channel: "workflow.phase",
            threadId: phaseRun.threadId,
            phaseRunId: event.payload.phaseRunId,
            event: "completed",
            phaseInfo: phaseRun.phaseInfo,
            outputs: event.payload.outputs,
            timestamp: event.payload.completedAt,
          },
        ],
      };
    }
    case "thread.phase-failed": {
      const phaseRun = state.phaseRunInfoById.get(event.payload.phaseRunId);
      if (!phaseRun) {
        return { state, emit: [] };
      }

      return {
        state,
        emit: [
          {
            channel: "workflow.phase",
            threadId: phaseRun.threadId,
            phaseRunId: event.payload.phaseRunId,
            event: "failed",
            phaseInfo: phaseRun.phaseInfo,
            error: event.payload.error,
            timestamp: event.payload.failedAt,
          },
        ],
      };
    }
    case "thread.phase-skipped": {
      const phaseRun = state.phaseRunInfoById.get(event.payload.phaseRunId);
      if (!phaseRun) {
        return { state, emit: [] };
      }

      return {
        state,
        emit: [
          {
            channel: "workflow.phase",
            threadId: phaseRun.threadId,
            phaseRunId: event.payload.phaseRunId,
            event: "skipped",
            phaseInfo: phaseRun.phaseInfo,
            timestamp: event.payload.skippedAt,
          },
        ],
      };
    }
    case "thread.quality-check-started":
      return {
        state,
        emit: [
          {
            channel: "workflow.gate",
            threadId: event.payload.threadId,
            phaseRunId: event.payload.phaseRunId,
            gateType: "quality-checks",
            status: "evaluating",
            timestamp: event.payload.startedAt,
          },
          ...event.payload.checks.map(
            (check): WorkflowPushEvent => ({
              channel: "workflow.quality-check",
              threadId: event.payload.threadId,
              phaseRunId: event.payload.phaseRunId,
              checkName: check.check,
              status: "running",
              timestamp: event.payload.startedAt,
            }),
          ),
        ],
      };
    case "thread.quality-check-completed":
      return {
        state,
        emit: [
          {
            channel: "workflow.gate",
            threadId: event.payload.threadId,
            phaseRunId: event.payload.phaseRunId,
            gateType: "quality-checks",
            status: event.payload.results.every((result) => result.passed) ? "passed" : "failed",
            timestamp: event.payload.completedAt,
          },
          ...event.payload.results.map(
            (result): WorkflowPushEvent => ({
              channel: "workflow.quality-check",
              threadId: event.payload.threadId,
              phaseRunId: event.payload.phaseRunId,
              checkName: result.check,
              status: result.passed ? "passed" : "failed",
              ...(result.output !== undefined ? { output: result.output } : {}),
              timestamp: event.payload.completedAt,
            }),
          ),
        ],
      };
    case "thread.bootstrap-started":
      return {
        state,
        emit: [
          {
            channel: "workflow.bootstrap",
            threadId: event.payload.threadId,
            event: "started",
            timestamp: event.payload.startedAt,
          },
        ],
      };
    case "thread.bootstrap-completed":
      return {
        state,
        emit: [
          {
            channel: "workflow.bootstrap",
            threadId: event.payload.threadId,
            event: "completed",
            timestamp: event.payload.completedAt,
          },
        ],
      };
    case "thread.bootstrap-failed":
      return {
        state,
        emit: [
          {
            channel: "workflow.bootstrap",
            threadId: event.payload.threadId,
            event: "failed",
            data: event.payload.stdout,
            error: event.payload.error,
            timestamp: event.payload.failedAt,
          },
        ],
      };
    case "thread.bootstrap-skipped":
      return {
        state,
        emit: [
          {
            channel: "workflow.bootstrap",
            threadId: event.payload.threadId,
            event: "skipped",
            timestamp: event.payload.skippedAt,
          },
        ],
      };
    case "request.opened": {
      if (event.payload.payload.type !== "gate") {
        return { state, emit: [] };
      }

      const gateType = toWorkflowGateType(event.payload.payload.gateType);
      if (gateType === null) {
        return { state, emit: [] };
      }

      return {
        state: {
          ...state,
          gateRequestsById: new Map(state.gateRequestsById).set(event.payload.requestId, {
            threadId: event.payload.threadId,
            phaseRunId: event.payload.payload.phaseRunId,
            gateType,
          }),
        },
        emit: [
          {
            channel: "workflow.gate",
            threadId: event.payload.threadId,
            phaseRunId: event.payload.payload.phaseRunId,
            gateType,
            status: "waiting-human",
            requestId: event.payload.requestId,
            timestamp: event.payload.createdAt,
          },
        ],
      };
    }
    case "request.resolved": {
      const gateRequest = state.gateRequestsById.get(event.payload.requestId);
      if (!gateRequest) {
        return { state, emit: [] };
      }

      const resolvedWith = event.payload.resolvedWith;
      const nextGateRequestsById = new Map(state.gateRequestsById);
      nextGateRequestsById.delete(event.payload.requestId);

      if (
        !("decision" in resolvedWith) ||
        (resolvedWith.decision !== "approve" && resolvedWith.decision !== "reject")
      ) {
        return {
          state: {
            ...state,
            gateRequestsById: nextGateRequestsById,
          },
          emit: [],
        };
      }

      return {
        state: {
          ...state,
          gateRequestsById: nextGateRequestsById,
        },
        emit: [
          {
            channel: "workflow.gate",
            threadId: gateRequest.threadId,
            phaseRunId: gateRequest.phaseRunId,
            gateType: gateRequest.gateType,
            status: resolvedWith.decision === "approve" ? "passed" : "failed",
            timestamp: event.payload.resolvedAt,
          },
        ],
      };
    }
    case "request.stale": {
      if (!state.gateRequestsById.has(event.payload.requestId)) {
        return { state, emit: [] };
      }

      const nextGateRequestsById = new Map(state.gateRequestsById);
      nextGateRequestsById.delete(event.payload.requestId);

      return {
        state: {
          ...state,
          gateRequestsById: nextGateRequestsById,
        },
        emit: [],
      };
    }
    default:
      return { state, emit: [] };
  }
}

function mapChannelPushEvents(
  state: ChannelPushStreamState,
  event: ForgeEventEnvelope,
): {
  readonly state: ChannelPushStreamState;
  readonly emit: Array<ChannelPushEvent>;
} {
  switch (event.type) {
    case "channel.created":
      return {
        state: {
          ...state,
          ownerThreadIdByChannelId: new Map(state.ownerThreadIdByChannelId).set(
            event.payload.channelId,
            event.payload.threadId,
          ),
        },
        emit: [],
      };
    case "channel.message-posted": {
      const ownerThreadId = state.ownerThreadIdByChannelId.get(event.payload.channelId);
      if (!ownerThreadId) {
        return { state, emit: [] };
      }

      return {
        state,
        emit: [
          {
            channel: "channel.message",
            channelId: event.payload.channelId,
            threadId: ownerThreadId,
            message: {
              id: event.payload.messageId,
              channelId: event.payload.channelId,
              sequence: event.payload.sequence,
              fromType: event.payload.fromType,
              fromId: event.payload.fromId,
              ...(event.payload.fromRole !== null ? { fromRole: event.payload.fromRole } : {}),
              content: event.payload.content,
              createdAt: event.payload.createdAt,
            },
            timestamp: event.payload.createdAt,
          },
        ],
      };
    }
    case "channel.conclusion-proposed": {
      const ownerThreadId = state.ownerThreadIdByChannelId.get(event.payload.channelId);
      if (!ownerThreadId) {
        return { state, emit: [] };
      }

      return {
        state,
        emit: [
          {
            channel: "channel.conclusion",
            channelId: event.payload.channelId,
            threadId: ownerThreadId,
            sessionId: event.payload.threadId,
            summary: event.payload.summary,
            allProposed: false,
            timestamp: event.payload.proposedAt,
          },
        ],
      };
    }
    case "channel.concluded":
      return {
        state,
        emit: [
          {
            channel: "channel.status",
            channelId: event.payload.channelId,
            status: "concluded",
            timestamp: event.payload.concludedAt,
          },
        ],
      };
    case "channel.closed":
      return {
        state,
        emit: [
          {
            channel: "channel.status",
            channelId: event.payload.channelId,
            status: "closed",
            timestamp: event.payload.closedAt,
          },
        ],
      };
    default:
      return { state, emit: [] };
  }
}

const WsRpcLayer = WsRpcGroup.toLayer(
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const checkpointDiffQuery = yield* CheckpointDiffQuery;
    const channelService = yield* ChannelService;
    const keybindings = yield* Keybindings;
    const open = yield* Open;
    const gitManager = yield* GitManager;
    const git = yield* GitCore;
    const terminalManager = yield* TerminalManager;
    const providerRegistry = yield* ProviderRegistry;
    const config = yield* ServerConfig;
    const lifecycleEvents = yield* ServerLifecycleEvents;
    const serverSettings = yield* ServerSettingsService;
    const startup = yield* ServerRuntimeStartup;
    const workspaceEntries = yield* WorkspaceEntries;
    const workspaceFileSystem = yield* WorkspaceFileSystem;
    const discussionRegistry = yield* DiscussionRegistry;
    const workflowRegistry = yield* WorkflowRegistry;
    const workflowRepository = yield* ProjectionWorkflowRepository;
    const phaseRuns = yield* ProjectionPhaseRunRepository;
    const phaseOutputs = yield* ProjectionPhaseOutputRepository;
    const threads = yield* ProjectionThreadRepository;
    const threadMessages = yield* ProjectionThreadMessageRepository;
    const threadSessions = yield* ProjectionThreadSessionRepository;
    const interactiveRequests = yield* ProjectionInteractiveRequestRepository;

    const toSessionSummary = Effect.fn("ws.toSessionSummary")(function* (
      thread: ProjectionThread,
      allThreads: ReadonlyArray<ProjectionThread>,
      pendingThreadIds: ReadonlySet<string>,
    ) {
      const threadSession = yield* threadSessions
        .getByThreadId({
          threadId: thread.threadId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: "Failed to load thread runtime state",
                cause,
              }),
          ),
        );

      return {
        threadId: thread.threadId,
        projectId: thread.projectId,
        parentThreadId: thread.parentThreadId,
        sessionType: deriveSessionType(thread),
        title: thread.title,
        status: deriveSessionStatus({
          thread,
          runtimeStatus: Option.match(threadSession, {
            onNone: () => null,
            onSome: (value) => value.status,
          }),
          hasPendingRequest: pendingThreadIds.has(thread.threadId),
        }),
        role: thread.role,
        provider: thread.modelSelection.provider,
        model: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        workflowId: thread.workflowId,
        currentPhaseId: thread.currentPhaseId,
        discussionId: thread.discussionId,
        branch: thread.branch,
        bootstrapStatus: thread.bootstrapStatus,
        childThreadIds: allThreads
          .filter((candidate) => candidate.parentThreadId === thread.threadId)
          .map((candidate) => candidate.threadId),
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        archivedAt: thread.archivedAt,
      };
    });

    const makeWorkflowPushStream = Effect.fn("ws.makeWorkflowPushStream")(function* () {
      const snapshot = yield* orchestrationEngine.getReadModel();
      const fromSequenceExclusive = snapshot.snapshotSequence;
      const orderedEvents = orchestrationEngine
        .streamEventsFromSequence(fromSequenceExclusive)
        .pipe(
          Stream.flatMap((event) => {
            const forgeEvent = toForgeEventEnvelope(event);
            return Stream.fromIterable(forgeEvent === null ? [] : [forgeEvent]);
          }),
          Stream.catch(() => Stream.empty),
        );
      const workflowState = yield* Ref.make(createWorkflowPushStreamState(snapshot));

      return orderedEvents.pipe(
        Stream.mapEffect((event) =>
          Ref.modify(workflowState, (state) => {
            const next = mapWorkflowPushEvents(state, event);
            return [next.emit, next.state] as const;
          }),
        ),
        Stream.flatMap((events) => Stream.fromIterable(events)),
      );
    });

    const makeChannelPushStream = Effect.fn("ws.makeChannelPushStream")(function* () {
      const snapshot = yield* orchestrationEngine.getReadModel();
      const fromSequenceExclusive = snapshot.snapshotSequence;
      const orderedEvents = orchestrationEngine
        .streamEventsFromSequence(fromSequenceExclusive)
        .pipe(
          Stream.flatMap((event) => {
            const forgeEvent = toForgeEventEnvelope(event);
            return Stream.fromIterable(forgeEvent === null ? [] : [forgeEvent]);
          }),
          Stream.catch(() => Stream.empty),
        );
      const channelState = yield* Ref.make(createChannelPushStreamState(snapshot));

      return orderedEvents.pipe(
        Stream.mapEffect((event) =>
          Ref.modify(channelState, (state) => {
            const next = mapChannelPushEvents(state, event);
            return [next.emit, next.state] as const;
          }),
        ),
        Stream.flatMap((events) => Stream.fromIterable(events)),
      );
    });

    const loadServerConfig = Effect.gen(function* () {
      const keybindingsConfig = yield* keybindings.loadConfigState;
      const providers = yield* providerRegistry.getProviders;
      const settings = yield* serverSettings.getSettings;

      return {
        cwd: config.cwd,
        keybindingsConfigPath: config.keybindingsConfigPath,
        keybindings: keybindingsConfig.keybindings,
        issues: keybindingsConfig.issues,
        providers,
        availableEditors: resolveAvailableEditors(),
        observability: {
          logsDirectoryPath: config.logsDir,
          localTracingEnabled: true,
          ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
          otlpTracesEnabled: config.otlpTracesUrl !== undefined,
          ...(config.otlpMetricsUrl !== undefined ? { otlpMetricsUrl: config.otlpMetricsUrl } : {}),
          otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
        },
        settings,
      };
    });

    const loadTranscript = Effect.fn("ws.loadTranscript")(function* (
      threadId: ThreadId,
      offset?: number,
      limit?: number,
    ) {
      const threadOption = yield* threads.getById({ threadId }).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationGetSnapshotError({
              message: "Failed to load transcript thread context",
              cause,
            }),
        ),
      );
      if (Option.isNone(threadOption)) {
        return yield* new OrchestrationGetSnapshotError({
          message: `Failed to load transcript: thread '${threadId}' was not found.`,
        });
      }
      if (threadOption.value.transcriptArchived) {
        return yield* new OrchestrationGetSnapshotError({
          message: `Failed to load transcript: thread '${threadId}' transcript has been archived.`,
        });
      }

      const entries = yield* threadMessages.listByThreadId({ threadId }).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationGetSnapshotError({
              message: "Failed to load transcript entries",
              cause,
            }),
        ),
      );
      return {
        entries: paginateEntries(entries.map(toTranscriptEntry), offset, limit),
        total: entries.length,
      };
    });

    const loadChildren = Effect.fn("ws.loadChildren")(function* (threadId: ThreadId) {
      const threadOption = yield* threads.getById({ threadId }).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationGetSnapshotError({
              message: "Failed to load parent thread context",
              cause,
            }),
        ),
      );
      if (Option.isNone(threadOption)) {
        return yield* new OrchestrationGetSnapshotError({
          message: `Failed to load child sessions: thread '${threadId}' was not found.`,
        });
      }

      const siblingThreads = yield* threads
        .listByProjectId({
          projectId: threadOption.value.projectId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: "Failed to load child thread rows",
                cause,
              }),
          ),
        );
      const pendingRequests = yield* interactiveRequests.queryPending().pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationGetSnapshotError({
              message: "Failed to load pending interactive requests",
              cause,
            }),
        ),
      );
      const pendingThreadIds = new Set<string>();
      for (const request of pendingRequests) {
        pendingThreadIds.add(request.threadId);
        if (request.childThreadId !== null) {
          pendingThreadIds.add(request.childThreadId);
        }
      }

      const children = siblingThreads.filter((candidate) => candidate.parentThreadId === threadId);
      return {
        children: yield* Effect.forEach(children, (child) =>
          toSessionSummary(child, siblingThreads, pendingThreadIds),
        ),
      };
    });

    const loadChannel = Effect.fn("ws.loadChannel")(function* (channelId: Channel["id"]) {
      const readModel = yield* orchestrationEngine.getReadModel();
      const channel = readModel.channels.find((entry) => entry.id === channelId);
      if (!channel) {
        return yield* new OrchestrationGetSnapshotError({
          message: `Failed to load channel '${channelId}'.`,
        });
      }
      return channel;
    });

    const upsertWorkflow = Effect.fn("ws.upsertWorkflow")(function* (workflow: WorkflowDefinition) {
      const persistedWorkflow = {
        ...workflow,
        builtIn: false,
        updatedAt: workflow.updatedAt,
      };
      yield* workflowRepository.upsert({
        workflowId: persistedWorkflow.id,
        name: persistedWorkflow.name,
        description: persistedWorkflow.description,
        phases: persistedWorkflow.phases,
        builtIn: false,
        projectId: persistedWorkflow.projectId,
        ...(persistedWorkflow.onCompletion ? { onCompletion: persistedWorkflow.onCompletion } : {}),
        createdAt: persistedWorkflow.createdAt,
        updatedAt: persistedWorkflow.updatedAt,
      });

      return {
        workflow: persistedWorkflow,
      };
    });

    return WsRpcGroup.of({
      [ORCHESTRATION_WS_METHODS.getSnapshot]: (_input) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.getSnapshot,
          projectionSnapshotQuery.getSnapshot().pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetSnapshotError({
                  message: "Failed to load orchestration snapshot",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "orchestration" },
        ),
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.dispatchCommand,
          Effect.gen(function* () {
            const normalizedCommand = yield* normalizeDispatchCommand(command);
            const result = yield* startup.enqueueCommand(
              orchestrationEngine.dispatch(normalizedCommand),
            );
            if (normalizedCommand.type === "thread.archive") {
              yield* terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("failed to close thread terminals after archive", {
                    threadId: normalizedCommand.threadId,
                    error: error.message,
                  }),
                ),
              );
            }
            return result;
          }).pipe(
            Effect.mapError((cause) =>
              Schema.is(OrchestrationDispatchCommandError)(cause)
                ? cause
                : new OrchestrationDispatchCommandError({
                    message: "Failed to dispatch orchestration command",
                    cause,
                  }),
            ),
          ),
          { "rpc.aggregate": "orchestration" },
        ),
      [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.getTurnDiff,
          checkpointDiffQuery.getTurnDiff(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetTurnDiffError({
                  message: "Failed to load turn diff",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "orchestration" },
        ),
      [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.getFullThreadDiff,
          checkpointDiffQuery.getFullThreadDiff(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetFullThreadDiffError({
                  message: "Failed to load full thread diff",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "orchestration" },
        ),
      [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.replayEvents,
          Stream.runCollect(
            orchestrationEngine.readEvents(
              clamp(input.fromSequenceExclusive, { maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
            ),
          ).pipe(
            Effect.map((events) => Array.from(events)),
            Effect.mapError(
              (cause) =>
                new OrchestrationReplayEventsError({
                  message: "Failed to replay orchestration events",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "orchestration" },
        ),
      [WS_METHODS.threadGetTranscript]: ({ threadId, offset, limit }) =>
        observeRpcEffect(WS_METHODS.threadGetTranscript, loadTranscript(threadId, offset, limit), {
          "rpc.aggregate": "session",
        }),
      [WS_METHODS.threadGetChildren]: ({ threadId }) =>
        observeRpcEffect(WS_METHODS.threadGetChildren, loadChildren(threadId), {
          "rpc.aggregate": "session",
        }),
      [WS_METHODS.sessionGetTranscript]: ({ sessionId, offset, limit }) =>
        observeRpcEffect(
          WS_METHODS.sessionGetTranscript,
          loadTranscript(sessionId, offset, limit),
          {
            "rpc.aggregate": "session",
          },
        ),
      [WS_METHODS.sessionGetChildren]: ({ sessionId }) =>
        observeRpcEffect(WS_METHODS.sessionGetChildren, loadChildren(sessionId), {
          "rpc.aggregate": "session",
        }),
      [WS_METHODS.channelGetMessages]: ({ channelId, afterSequence, limit }) =>
        observeRpcEffect(
          WS_METHODS.channelGetMessages,
          channelService
            .getMessages({
              channelId,
              ...(afterSequence === undefined ? {} : { afterSequence }),
              ...(limit === undefined || limit <= 0 ? {} : { limit }),
            })
            .pipe(
              Effect.map((messages) => ({
                messages,
                total: messages.length,
              })),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load channel messages",
                    cause,
                  }),
              ),
            ),
          { "rpc.aggregate": "channel" },
        ),
      [WS_METHODS.channelGetChannel]: ({ channelId }) =>
        observeRpcEffect(
          WS_METHODS.channelGetChannel,
          loadChannel(channelId).pipe(Effect.map((channel) => ({ channel }))),
          { "rpc.aggregate": "channel" },
        ),
      [WS_METHODS.phaseRunList]: ({ threadId }) =>
        observeRpcEffect(
          WS_METHODS.phaseRunList,
          phaseRuns.queryByThreadId({ threadId }).pipe(
            Effect.map((loadedPhaseRuns) => ({ phaseRuns: loadedPhaseRuns })),
            Effect.mapError(
              (cause) =>
                new OrchestrationGetSnapshotError({
                  message: "Failed to load phase runs",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "workflow" },
        ),
      [WS_METHODS.phaseRunGet]: ({ phaseRunId }) =>
        observeRpcEffect(
          WS_METHODS.phaseRunGet,
          phaseRuns.queryById({ phaseRunId }).pipe(
            Effect.flatMap((phaseRunOption) =>
              Option.isNone(phaseRunOption)
                ? Effect.fail(
                    new OrchestrationGetSnapshotError({
                      message: `Failed to load phase run '${phaseRunId}'.`,
                    }),
                  )
                : Effect.succeed({ phaseRun: phaseRunOption.value }),
            ),
            Effect.mapError((cause) =>
              Schema.is(OrchestrationGetSnapshotError)(cause)
                ? cause
                : new OrchestrationGetSnapshotError({
                    message: "Failed to load phase run",
                    cause,
                  }),
            ),
          ),
          { "rpc.aggregate": "workflow" },
        ),
      [WS_METHODS.phaseOutputGet]: ({ phaseRunId, outputKey }) =>
        observeRpcEffect(
          WS_METHODS.phaseOutputGet,
          phaseOutputs.queryByKey({ phaseRunId, outputKey }).pipe(
            Effect.flatMap((outputOption) =>
              Option.isNone(outputOption)
                ? Effect.fail(
                    new OrchestrationGetSnapshotError({
                      message: `Failed to load phase output '${outputKey}' for phase run '${phaseRunId}'.`,
                    }),
                  )
                : Effect.succeed({ output: outputOption.value }),
            ),
            Effect.mapError((cause) =>
              Schema.is(OrchestrationGetSnapshotError)(cause)
                ? cause
                : new OrchestrationGetSnapshotError({
                    message: "Failed to load phase output",
                    cause,
                  }),
            ),
          ),
          { "rpc.aggregate": "workflow" },
        ),
      [WS_METHODS.workflowList]: (_input) =>
        observeRpcEffect(
          WS_METHODS.workflowList,
          workflowRegistry.queryAll().pipe(
            Effect.map((workflows) => ({
              workflows: workflows.map((workflow) => ({
                workflowId: workflow.id,
                name: workflow.name,
                description: workflow.description,
                builtIn: workflow.builtIn,
                projectId: workflow.projectId,
                hasDeliberation: workflowHasDeliberation(workflow.phases),
              })),
            })),
            Effect.mapError(
              (cause) =>
                new OrchestrationGetSnapshotError({
                  message: "Failed to load workflows",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "workflow" },
        ),
      [WS_METHODS.workflowGet]: ({ workflowId }) =>
        observeRpcEffect(
          WS_METHODS.workflowGet,
          workflowRegistry.queryById({ workflowId }).pipe(
            Effect.flatMap((workflowOption) =>
              Option.isNone(workflowOption)
                ? Effect.fail(
                    new OrchestrationGetSnapshotError({
                      message: `Failed to load workflow '${workflowId}'.`,
                    }),
                  )
                : Effect.succeed({ workflow: workflowOption.value }),
            ),
            Effect.mapError((cause) =>
              Schema.is(OrchestrationGetSnapshotError)(cause)
                ? cause
                : new OrchestrationGetSnapshotError({
                    message: "Failed to load workflow",
                    cause,
                  }),
            ),
          ),
          { "rpc.aggregate": "workflow" },
        ),
      [WS_METHODS.workflowCreate]: ({ workflow }) =>
        observeRpcEffect(
          WS_METHODS.workflowCreate,
          upsertWorkflow(workflow).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetSnapshotError({
                  message: "Failed to create workflow",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "workflow" },
        ),
      [WS_METHODS.workflowUpdate]: ({ workflow }) =>
        observeRpcEffect(
          WS_METHODS.workflowUpdate,
          upsertWorkflow(workflow).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetSnapshotError({
                  message: "Failed to update workflow",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "workflow" },
        ),
      [WS_METHODS.discussionList]: ({ workspaceRoot }) =>
        observeRpcEffect(
          WS_METHODS.discussionList,
          discussionRegistry.queryAll(workspaceRoot ? { workspaceRoot } : {}).pipe(
            Effect.map((discussions) => ({
              discussions: discussions.map((d) => ({
                name: d.name,
                description: d.description,
                participantRoles: d.participants.map((p) => p.role),
                scope: d.scope,
              })),
            })),
            Effect.mapError(
              (cause) =>
                new OrchestrationGetSnapshotError({
                  message: "Failed to load discussions",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "discussion" },
        ),
      [WS_METHODS.discussionGet]: ({ name, workspaceRoot }) =>
        observeRpcEffect(
          WS_METHODS.discussionGet,
          discussionRegistry.queryByName(workspaceRoot ? { name, workspaceRoot } : { name }).pipe(
            Effect.flatMap((discussionOption) =>
              Option.isNone(discussionOption)
                ? Effect.fail(
                    new OrchestrationGetSnapshotError({
                      message: `Discussion '${name}' not found.`,
                    }),
                  )
                : Effect.succeed({ discussion: discussionOption.value }),
            ),
            Effect.mapError((cause) =>
              Schema.is(OrchestrationGetSnapshotError)(cause)
                ? cause
                : new OrchestrationGetSnapshotError({
                    message: "Failed to load discussion",
                    cause,
                  }),
            ),
          ),
          { "rpc.aggregate": "discussion" },
        ),
      [WS_METHODS.discussionListManaged]: ({ workspaceRoot }) =>
        observeRpcEffect(
          WS_METHODS.discussionListManaged,
          discussionRegistry.queryManagedAll(workspaceRoot ? { workspaceRoot } : {}).pipe(
            Effect.map((discussions) => ({
              discussions: discussions.map((discussion) => ({
                name: discussion.name,
                description: discussion.description,
                participantRoles: discussion.participants.map((participant) => participant.role),
                scope: discussion.scope,
                effective: discussion.effective,
              })),
            })),
            Effect.mapError(
              (cause) =>
                new OrchestrationGetSnapshotError({
                  message: "Failed to load managed discussions",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "discussion" },
        ),
      [WS_METHODS.discussionGetManaged]: ({ name, scope, workspaceRoot }) =>
        observeRpcEffect(
          WS_METHODS.discussionGetManaged,
          discussionRegistry
            .queryManagedByName(workspaceRoot ? { name, scope, workspaceRoot } : { name, scope })
            .pipe(
              Effect.flatMap((discussionOption) =>
                Option.isNone(discussionOption)
                  ? Effect.fail(
                      new OrchestrationGetSnapshotError({
                        message: `Discussion '${name}' with scope '${scope}' not found.`,
                      }),
                    )
                  : Effect.succeed({ discussion: discussionOption.value }),
              ),
              Effect.mapError((cause) =>
                Schema.is(OrchestrationGetSnapshotError)(cause)
                  ? cause
                  : new OrchestrationGetSnapshotError({
                      message: "Failed to load managed discussion",
                      cause,
                    }),
              ),
            ),
          { "rpc.aggregate": "discussion" },
        ),
      [WS_METHODS.discussionCreate]: ({ discussion, scope, workspaceRoot }) =>
        observeRpcEffect(
          WS_METHODS.discussionCreate,
          discussionRegistry
            .create(workspaceRoot ? { discussion, scope, workspaceRoot } : { discussion, scope })
            .pipe(
              Effect.map((createdDiscussion) => ({ discussion: createdDiscussion })),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to create discussion",
                    cause,
                  }),
              ),
            ),
          { "rpc.aggregate": "discussion" },
        ),
      [WS_METHODS.discussionUpdate]: ({
        previousName,
        previousScope,
        discussion,
        scope,
        workspaceRoot,
      }) =>
        observeRpcEffect(
          WS_METHODS.discussionUpdate,
          discussionRegistry
            .update(
              workspaceRoot
                ? { previousName, previousScope, discussion, scope, workspaceRoot }
                : { previousName, previousScope, discussion, scope },
            )
            .pipe(
              Effect.map((updatedDiscussion) => ({ discussion: updatedDiscussion })),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to update discussion",
                    cause,
                  }),
              ),
            ),
          { "rpc.aggregate": "discussion" },
        ),
      [WS_METHODS.discussionDelete]: ({ name, scope, workspaceRoot }) =>
        observeRpcEffect(
          WS_METHODS.discussionDelete,
          discussionRegistry
            .delete(workspaceRoot ? { name, scope, workspaceRoot } : { name, scope })
            .pipe(
              Effect.map(() => ({})),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to delete discussion",
                    cause,
                  }),
              ),
            ),
          { "rpc.aggregate": "discussion" },
        ),
      [WS_METHODS.subscribeOrchestrationDomainEvents]: (input) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeOrchestrationDomainEvents,
          Effect.gen(function* () {
            const fromSequenceExclusive =
              input.fromSequenceExclusive ??
              (yield* orchestrationEngine.getReadModel()).snapshotSequence;
            return orchestrationEngine
              .streamEventsFromSequence(fromSequenceExclusive)
              .pipe(Stream.catch(() => Stream.empty));
          }),
          { "rpc.aggregate": "orchestration" },
        ),
      [WS_METHODS.subscribeWorkflowEvents]: ({ threadId }) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeWorkflowEvents,
          makeWorkflowPushStream().pipe(
            Effect.map((pushStream) =>
              threadId === undefined
                ? pushStream
                : pushStream.pipe(Stream.filter((event) => event.threadId === threadId)),
            ),
          ),
          { "rpc.aggregate": "workflow" },
        ),
      [WS_METHODS.subscribeChannelMessages]: ({ channelId }) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeChannelMessages,
          makeChannelPushStream().pipe(
            Effect.map((pushStream) =>
              channelId === undefined
                ? pushStream
                : pushStream.pipe(Stream.filter((event) => event.channelId === channelId)),
            ),
          ),
          { "rpc.aggregate": "channel" },
        ),
      [WS_METHODS.subscribeWorkflowPhase]: ({ threadId }) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeWorkflowPhase,
          makeWorkflowPushStream().pipe(
            Effect.map((pushStream) =>
              pushStream.pipe(
                Stream.filter(
                  (event): event is Extract<WorkflowPushEvent, { channel: "workflow.phase" }> =>
                    event.channel === "workflow.phase" &&
                    (threadId === undefined || event.threadId === threadId),
                ),
              ),
            ),
          ),
          { "rpc.aggregate": "workflow" },
        ),
      [WS_METHODS.subscribeWorkflowQualityChecks]: ({ threadId }) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeWorkflowQualityChecks,
          makeWorkflowPushStream().pipe(
            Effect.map((pushStream) =>
              pushStream.pipe(
                Stream.filter(
                  (
                    event,
                  ): event is Extract<WorkflowPushEvent, { channel: "workflow.quality-check" }> =>
                    event.channel === "workflow.quality-check" &&
                    (threadId === undefined || event.threadId === threadId),
                ),
              ),
            ),
          ),
          { "rpc.aggregate": "workflow" },
        ),
      [WS_METHODS.subscribeWorkflowBootstrap]: ({ threadId }) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeWorkflowBootstrap,
          makeWorkflowPushStream().pipe(
            Effect.map((pushStream) =>
              pushStream.pipe(
                Stream.filter(
                  (event): event is Extract<WorkflowPushEvent, { channel: "workflow.bootstrap" }> =>
                    event.channel === "workflow.bootstrap" &&
                    (threadId === undefined || event.threadId === threadId),
                ),
              ),
            ),
          ),
          { "rpc.aggregate": "workflow" },
        ),
      [WS_METHODS.subscribeWorkflowGate]: ({ threadId }) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeWorkflowGate,
          makeWorkflowPushStream().pipe(
            Effect.map((pushStream) =>
              pushStream.pipe(
                Stream.filter(
                  (event): event is Extract<WorkflowPushEvent, { channel: "workflow.gate" }> =>
                    event.channel === "workflow.gate" &&
                    (threadId === undefined || event.threadId === threadId),
                ),
              ),
            ),
          ),
          { "rpc.aggregate": "workflow" },
        ),
      [WS_METHODS.subscribeChannelMessage]: ({ channelId }) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeChannelMessage,
          makeChannelPushStream().pipe(
            Effect.map((pushStream) =>
              pushStream.pipe(
                Stream.filter(
                  (event): event is Extract<ChannelPushEvent, { channel: "channel.message" }> =>
                    event.channel === "channel.message" &&
                    (channelId === undefined || event.channelId === channelId),
                ),
              ),
            ),
          ),
          { "rpc.aggregate": "channel" },
        ),
      [WS_METHODS.serverGetConfig]: (_input) =>
        observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.serverRefreshProviders]: (_input) =>
        observeRpcEffect(
          WS_METHODS.serverRefreshProviders,
          providerRegistry.refresh().pipe(Effect.map((providers) => ({ providers }))),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.serverUpsertKeybinding]: (rule) =>
        observeRpcEffect(
          WS_METHODS.serverUpsertKeybinding,
          Effect.gen(function* () {
            const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
            return { keybindings: keybindingsConfig, issues: [] };
          }),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.serverGetSettings]: (_input) =>
        observeRpcEffect(WS_METHODS.serverGetSettings, serverSettings.getSettings, {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
        observeRpcEffect(WS_METHODS.serverUpdateSettings, serverSettings.updateSettings(patch), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.projectsSearchEntries]: (input) =>
        observeRpcEffect(
          WS_METHODS.projectsSearchEntries,
          workspaceEntries.search(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectSearchEntriesError({
                  message: `Failed to search workspace entries: ${cause.detail}`,
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "workspace" },
        ),
      [WS_METHODS.projectsWriteFile]: (input) =>
        observeRpcEffect(
          WS_METHODS.projectsWriteFile,
          workspaceFileSystem.writeFile(input).pipe(
            Effect.mapError((cause) => {
              const message = Schema.is(WorkspacePathOutsideRootError)(cause)
                ? "Workspace file path must stay within the project root."
                : "Failed to write workspace file";
              return new ProjectWriteFileError({
                message,
                cause,
              });
            }),
          ),
          { "rpc.aggregate": "workspace" },
        ),
      [WS_METHODS.shellOpenInEditor]: (input) =>
        observeRpcEffect(WS_METHODS.shellOpenInEditor, open.openInEditor(input), {
          "rpc.aggregate": "workspace",
        }),
      [WS_METHODS.gitStatus]: (input) =>
        observeRpcEffect(WS_METHODS.gitStatus, gitManager.status(input), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitPull]: (input) =>
        observeRpcEffect(WS_METHODS.gitPull, git.pullCurrentBranch(input.cwd), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitRunStackedAction]: (input) =>
        observeRpcStream(
          WS_METHODS.gitRunStackedAction,
          Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
            gitManager
              .runStackedAction(input, {
                actionId: input.actionId,
                progressReporter: {
                  publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                },
              })
              .pipe(
                Effect.matchCauseEffect({
                  onFailure: (cause) => Queue.failCause(queue, cause),
                  onSuccess: () => Queue.end(queue).pipe(Effect.asVoid),
                }),
              ),
          ),
          { "rpc.aggregate": "git" },
        ),
      [WS_METHODS.gitResolvePullRequest]: (input) =>
        observeRpcEffect(WS_METHODS.gitResolvePullRequest, gitManager.resolvePullRequest(input), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitPreparePullRequestThread]: (input) =>
        observeRpcEffect(
          WS_METHODS.gitPreparePullRequestThread,
          gitManager.preparePullRequestThread(input),
          { "rpc.aggregate": "git" },
        ),
      [WS_METHODS.gitListBranches]: (input) =>
        observeRpcEffect(WS_METHODS.gitListBranches, git.listBranches(input), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitCreateWorktree]: (input) =>
        observeRpcEffect(WS_METHODS.gitCreateWorktree, git.createWorktree(input), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitRemoveWorktree]: (input) =>
        observeRpcEffect(WS_METHODS.gitRemoveWorktree, git.removeWorktree(input), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitCreateBranch]: (input) =>
        observeRpcEffect(WS_METHODS.gitCreateBranch, git.createBranch(input), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitCheckout]: (input) =>
        observeRpcEffect(WS_METHODS.gitCheckout, Effect.scoped(git.checkoutBranch(input)), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitInit]: (input) =>
        observeRpcEffect(WS_METHODS.gitInit, git.initRepo(input), { "rpc.aggregate": "git" }),
      [WS_METHODS.terminalOpen]: (input) =>
        observeRpcEffect(WS_METHODS.terminalOpen, terminalManager.open(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.terminalWrite]: (input) =>
        observeRpcEffect(WS_METHODS.terminalWrite, terminalManager.write(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.terminalResize]: (input) =>
        observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.terminalClear]: (input) =>
        observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.terminalRestart]: (input) =>
        observeRpcEffect(WS_METHODS.terminalRestart, terminalManager.restart(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.terminalClose]: (input) =>
        observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.subscribeTerminalEvents]: (_input) =>
        observeRpcStream(
          WS_METHODS.subscribeTerminalEvents,
          Stream.callback<TerminalEvent>((queue) =>
            Effect.acquireRelease(
              terminalManager.subscribe((event) => Queue.offer(queue, event)),
              (unsubscribe) => Effect.sync(unsubscribe),
            ),
          ),
          { "rpc.aggregate": "terminal" },
        ),
      [WS_METHODS.subscribeServerConfig]: (_input) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeServerConfig,
          Effect.gen(function* () {
            const keybindingsUpdates = keybindings.streamChanges.pipe(
              Stream.map((event) => ({
                version: 1 as const,
                type: "keybindingsUpdated" as const,
                payload: {
                  issues: event.issues,
                },
              })),
            );
            const providerStatuses = providerRegistry.streamChanges.pipe(
              Stream.map((providers) => ({
                version: 1 as const,
                type: "providerStatuses" as const,
                payload: { providers },
              })),
            );
            const settingsUpdates = serverSettings.streamChanges.pipe(
              Stream.map((settings) => ({
                version: 1 as const,
                type: "settingsUpdated" as const,
                payload: { settings },
              })),
            );

            return Stream.concat(
              Stream.make({
                version: 1 as const,
                type: "snapshot" as const,
                config: yield* loadServerConfig,
              }),
              Stream.merge(keybindingsUpdates, Stream.merge(providerStatuses, settingsUpdates)),
            );
          }),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.subscribeServerLifecycle]: (_input) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeServerLifecycle,
          Effect.gen(function* () {
            const snapshot = yield* lifecycleEvents.snapshot;
            const snapshotEvents = Array.from(snapshot.events).toSorted(
              (left, right) => left.sequence - right.sequence,
            );
            const liveEvents = lifecycleEvents.stream.pipe(
              Stream.filter((event) => event.sequence > snapshot.sequence),
            );
            return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
          }),
          { "rpc.aggregate": "server" },
        ),
    });
  }),
);

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
      spanPrefix: "ws.rpc",
      spanAttributes: {
        "rpc.transport": "websocket",
        "rpc.system": "effect-rpc",
      },
    }).pipe(Effect.provide(Layer.mergeAll(WsRpcLayer, RpcSerialization.layerJson)));
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const config = yield* ServerConfig;
        if (config.authToken) {
          const url = HttpServerRequest.toURL(request);
          if (Option.isNone(url)) {
            return HttpServerResponse.text("Invalid WebSocket URL", { status: 400 });
          }
          const token = url.value.searchParams.get("token");
          if (token !== config.authToken) {
            return HttpServerResponse.text("Unauthorized WebSocket connection", { status: 401 });
          }
        }
        return yield* rpcWebSocketHttpEffect;
      }),
    );
  }),
);
