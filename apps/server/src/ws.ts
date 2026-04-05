import { Effect, Layer, Option, Queue, Ref, Schema, Stream } from "effect";
import {
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
  type WorkflowPushEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
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
import { ProviderRegistry } from "./provider/Services/ProviderRegistry";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { TerminalManager } from "./terminal/Services/Manager";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem";
import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths";

type OrderedSequenceState<TEvent extends { readonly sequence: number }> = {
  readonly nextSequence: number;
  readonly pendingBySequence: Map<number, TEvent>;
};

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

function flushSequencedEvents<TEvent extends { readonly sequence: number }>(
  state: OrderedSequenceState<TEvent>,
  event: TEvent,
): [Array<TEvent>, OrderedSequenceState<TEvent>] {
  const { nextSequence, pendingBySequence } = state;
  if (event.sequence < nextSequence || pendingBySequence.has(event.sequence)) {
    return [[], state];
  }

  const updatedPending = new Map(pendingBySequence);
  updatedPending.set(event.sequence, event);

  const emit: Array<TEvent> = [];
  let expected = nextSequence;
  for (;;) {
    const expectedEvent = updatedPending.get(expected);
    if (!expectedEvent) {
      break;
    }
    emit.push(expectedEvent);
    updatedPending.delete(expected);
    expected += 1;
  }

  return [
    emit,
    {
      nextSequence: expected,
      pendingBySequence: updatedPending,
    },
  ];
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
      [WS_METHODS.subscribeOrchestrationDomainEvents]: (_input) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeOrchestrationDomainEvents,
          Effect.gen(function* () {
            const snapshot = yield* orchestrationEngine.getReadModel();
            const fromSequenceExclusive = snapshot.snapshotSequence;
            const replayEvents: Array<OrchestrationEvent> = yield* Stream.runCollect(
              orchestrationEngine.readEvents(fromSequenceExclusive),
            ).pipe(
              Effect.map((events) => Array.from(events)),
              Effect.catch(() => Effect.succeed([] as Array<OrchestrationEvent>)),
            );
            const replayStream = Stream.fromIterable(replayEvents);
            const source = Stream.merge(replayStream, orchestrationEngine.streamDomainEvents);
            type SequenceState = {
              readonly nextSequence: number;
              readonly pendingBySequence: Map<number, OrchestrationEvent>;
            };
            const state = yield* Ref.make<SequenceState>({
              nextSequence: fromSequenceExclusive + 1,
              pendingBySequence: new Map<number, OrchestrationEvent>(),
            });

            return source.pipe(
              Stream.mapEffect((event) =>
                Ref.modify(
                  state,
                  ({
                    nextSequence,
                    pendingBySequence,
                  }): [Array<OrchestrationEvent>, SequenceState] => {
                    if (event.sequence < nextSequence || pendingBySequence.has(event.sequence)) {
                      return [[], { nextSequence, pendingBySequence }];
                    }

                    const updatedPending = new Map(pendingBySequence);
                    updatedPending.set(event.sequence, event);

                    const emit: Array<OrchestrationEvent> = [];
                    let expected = nextSequence;
                    for (;;) {
                      const expectedEvent = updatedPending.get(expected);
                      if (!expectedEvent) {
                        break;
                      }
                      emit.push(expectedEvent);
                      updatedPending.delete(expected);
                      expected += 1;
                    }

                    return [emit, { nextSequence: expected, pendingBySequence: updatedPending }];
                  },
                ),
              ),
              Stream.flatMap((events) => Stream.fromIterable(events)),
            );
          }),
          { "rpc.aggregate": "orchestration" },
        ),
      [WS_METHODS.subscribeWorkflowEvents]: ({ threadId }) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeWorkflowEvents,
          Effect.gen(function* () {
            const snapshot = yield* orchestrationEngine.getReadModel();
            const fromSequenceExclusive = snapshot.snapshotSequence;
            const replayEvents: Array<ForgeEventEnvelope> = yield* Stream.runCollect(
              orchestrationEngine.readEvents(fromSequenceExclusive),
            ).pipe(
              Effect.map((events) =>
                Array.from(events).flatMap((event) => {
                  const forgeEvent = toForgeEventEnvelope(event);
                  return forgeEvent === null ? [] : [forgeEvent];
                }),
              ),
              Effect.catch(() => Effect.succeed([] as Array<ForgeEventEnvelope>)),
            );
            const orderedEvents = Stream.merge(
              Stream.fromIterable(replayEvents),
              orchestrationEngine.streamDomainEvents.pipe(
                Stream.flatMap((event) => {
                  const forgeEvent = toForgeEventEnvelope(event);
                  return Stream.fromIterable(forgeEvent === null ? [] : [forgeEvent]);
                }),
              ),
            );
            const sequenceState = yield* Ref.make<OrderedSequenceState<ForgeEventEnvelope>>({
              nextSequence: fromSequenceExclusive + 1,
              pendingBySequence: new Map<number, ForgeEventEnvelope>(),
            });
            const workflowState = yield* Ref.make(createWorkflowPushStreamState(snapshot));

            const pushStream = orderedEvents.pipe(
              Stream.mapEffect((event) =>
                Ref.modify(sequenceState, (state) => flushSequencedEvents(state, event)),
              ),
              Stream.flatMap((events) => Stream.fromIterable(events)),
              Stream.mapEffect((event) =>
                Ref.modify(workflowState, (state) => {
                  const next = mapWorkflowPushEvents(state, event);
                  return [next.emit, next.state] as const;
                }),
              ),
              Stream.flatMap((events) => Stream.fromIterable(events)),
            );

            return threadId === undefined
              ? pushStream
              : pushStream.pipe(Stream.filter((event) => event.threadId === threadId));
          }),
          { "rpc.aggregate": "workflow" },
        ),
      [WS_METHODS.subscribeChannelMessages]: ({ channelId }) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeChannelMessages,
          Effect.gen(function* () {
            const snapshot = yield* orchestrationEngine.getReadModel();
            const fromSequenceExclusive = snapshot.snapshotSequence;
            const replayEvents: Array<ForgeEventEnvelope> = yield* Stream.runCollect(
              orchestrationEngine.readEvents(fromSequenceExclusive),
            ).pipe(
              Effect.map((events) =>
                Array.from(events).flatMap((event) => {
                  const forgeEvent = toForgeEventEnvelope(event);
                  return forgeEvent === null ? [] : [forgeEvent];
                }),
              ),
              Effect.catch(() => Effect.succeed([] as Array<ForgeEventEnvelope>)),
            );
            const orderedEvents = Stream.merge(
              Stream.fromIterable(replayEvents),
              orchestrationEngine.streamDomainEvents.pipe(
                Stream.flatMap((event) => {
                  const forgeEvent = toForgeEventEnvelope(event);
                  return Stream.fromIterable(forgeEvent === null ? [] : [forgeEvent]);
                }),
              ),
            );
            const sequenceState = yield* Ref.make<OrderedSequenceState<ForgeEventEnvelope>>({
              nextSequence: fromSequenceExclusive + 1,
              pendingBySequence: new Map<number, ForgeEventEnvelope>(),
            });
            const channelState = yield* Ref.make(createChannelPushStreamState(snapshot));

            const pushStream = orderedEvents.pipe(
              Stream.mapEffect((event) =>
                Ref.modify(sequenceState, (state) => flushSequencedEvents(state, event)),
              ),
              Stream.flatMap((events) => Stream.fromIterable(events)),
              Stream.mapEffect((event) =>
                Ref.modify(channelState, (state) => {
                  const next = mapChannelPushEvents(state, event);
                  return [next.emit, next.state] as const;
                }),
              ),
              Stream.flatMap((events) => Stream.fromIterable(events)),
            );

            return channelId === undefined
              ? pushStream
              : pushStream.pipe(Stream.filter((event) => event.channelId === channelId));
          }),
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
