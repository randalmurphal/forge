import * as Crypto from "node:crypto";
import * as FSP from "node:fs/promises";
import * as Net from "node:net";
import * as Path from "node:path";

import {
  ChannelId,
  ChannelMessageId,
  CommandId,
  type InteractiveRequest,
  InteractiveRequestId,
  InteractiveRequestResolution,
  ModelSelection,
  NonNegativeInt,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  type OrchestrationReadModel,
  type OrchestrationThread,
  ProviderKind,
  type SessionStatus,
  type SessionSummary,
  type TranscriptEntry,
  type WorkflowSummary,
  PhaseRunId,
  ProjectId,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
  type WorkflowDefinition,
  WorkflowId,
} from "@forgetools/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import { ChannelService } from "../../channel/Services/ChannelService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkflowRegistry } from "../../workflow/Services/WorkflowRegistry.ts";
import {
  WorkspacePaths,
  WorkspaceRootNotDirectoryError,
  WorkspaceRootNotExistsError,
} from "../../workspace/Services/WorkspacePaths.ts";
import { DaemonSocketError } from "../Errors.ts";
import { SocketTransport, type SocketTransportShape } from "../Services/SocketTransport.ts";

const SOCKET_PERMISSIONS = 0o600;
const HUMAN_CHANNEL_PARTICIPANT_ID = "human";
const DEFAULT_CODEX_MODEL = {
  provider: "codex",
  model: "gpt-5-codex",
} as const satisfies ModelSelection;
const DEFAULT_CLAUDE_MODEL = {
  provider: "claudeAgent",
  model: "claude-opus-4-6",
} as const satisfies ModelSelection;

const ThreadIdParams = Schema.Struct({
  threadId: ThreadId,
});

const SessionIdParams = Schema.Struct({
  sessionId: ThreadId,
});

const ThreadCancelParams = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.optional(Schema.String),
});

const SessionCancelParams = Schema.Struct({
  sessionId: ThreadId,
  reason: Schema.optional(Schema.String),
});

const ThreadCorrectParams = Schema.Struct({
  threadId: ThreadId,
  content: Schema.String,
});

const SessionCorrectParams = Schema.Struct({
  sessionId: ThreadId,
  content: Schema.String,
});

const ThreadSendTurnParams = Schema.Struct({
  threadId: ThreadId,
  content: Schema.String,
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
});

const SessionSendTurnParams = Schema.Struct({
  sessionId: ThreadId,
  content: Schema.String,
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
});

const ThreadTranscriptParams = Schema.Struct({
  threadId: ThreadId,
  limit: Schema.optional(NonNegativeInt),
  offset: Schema.optional(NonNegativeInt),
});

const SessionTranscriptParams = Schema.Struct({
  sessionId: ThreadId,
  limit: Schema.optional(NonNegativeInt),
  offset: Schema.optional(NonNegativeInt),
});

const ThreadCreateParams = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  parentThreadId: Schema.optional(ThreadId),
  phaseRunId: Schema.optional(PhaseRunId),
  workflowId: Schema.optional(WorkflowId),
  patternId: Schema.optional(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  runtimeMode: Schema.optional(RuntimeMode),
  model: Schema.optional(ModelSelection),
  provider: Schema.optional(ProviderKind),
  role: Schema.optional(TrimmedNonEmptyString),
  branchOverride: Schema.optional(TrimmedNonEmptyString),
  requiresWorktree: Schema.optional(Schema.Boolean),
});

const SessionCreateParams = Schema.Struct({
  title: TrimmedNonEmptyString,
  type: Schema.optional(TrimmedNonEmptyString),
  workflow: Schema.optional(TrimmedNonEmptyString),
  projectPath: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  runtimeMode: Schema.optional(RuntimeMode),
  model: Schema.optional(ModelSelection),
  provider: Schema.optional(ProviderKind),
  role: Schema.optional(TrimmedNonEmptyString),
});

const GateApproveParams = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
});

const GateRejectParams = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  correction: Schema.optional(Schema.String),
});

const RequestResolveParams = Schema.Struct({
  requestId: InteractiveRequestId,
  resolvedWith: InteractiveRequestResolution,
});

const ChannelGetMessagesParams = Schema.Struct({
  channelId: ChannelId,
  afterSequence: Schema.optional(NonNegativeInt),
  limit: Schema.optional(NonNegativeInt),
});

const ChannelGetChannelParams = Schema.Struct({
  channelId: ChannelId,
});

const ChannelInterveneParams = Schema.Struct({
  channelId: ChannelId,
  content: Schema.String,
  fromRole: Schema.optional(TrimmedNonEmptyString),
});

const PhaseOutputUpdateParams = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  outputKey: TrimmedNonEmptyString,
  content: Schema.String,
});

const WorkflowGetParams = Schema.Struct({
  workflowId: WorkflowId,
});

const EmptyParams = Schema.Struct({});

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  readonly id: JsonRpcId | undefined;
  readonly method: string;
  readonly params?: unknown;
};

type JsonRpcResponse =
  | {
      readonly jsonrpc: "2.0";
      readonly id: JsonRpcId;
      readonly result: unknown;
    }
  | {
      readonly jsonrpc: "2.0";
      readonly id: JsonRpcId;
      readonly error: {
        readonly code: number;
        readonly message: string;
        readonly data?: unknown;
      };
    };

type SocketMethodError = OrchestrationDispatchCommandError | OrchestrationGetSnapshotError;

type JsonRpcHandler = (params: unknown) => Effect.Effect<unknown, SocketMethodError>;

function nowIso(): string {
  return new Date().toISOString();
}

function randomCommandId(prefix: string): CommandId {
  return CommandId.makeUnsafe(`${prefix}:${Crypto.randomUUID()}`);
}

function randomThreadId(): ThreadId {
  return ThreadId.makeUnsafe(Crypto.randomUUID());
}

function randomProjectId(): ProjectId {
  return ProjectId.makeUnsafe(Crypto.randomUUID());
}

function randomChannelMessageId(): ChannelMessageId {
  return ChannelMessageId.makeUnsafe(`channel-message:${Crypto.randomUUID()}`);
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function defaultModelSelection(provider?: string): ModelSelection {
  switch (provider) {
    case "claudeAgent":
      return DEFAULT_CLAUDE_MODEL;
    case "codex":
    case undefined:
      return DEFAULT_CODEX_MODEL;
    default:
      return {
        provider,
        model: DEFAULT_CODEX_MODEL.model,
      } as ModelSelection;
  }
}

function resolveModelSelection(input: {
  readonly explicitModel: ModelSelection | undefined;
  readonly explicitProvider: ProviderKind | undefined;
  readonly projectDefaultModel: ModelSelection | null | undefined;
}): ModelSelection {
  if (input.explicitModel !== undefined) {
    return input.explicitModel;
  }
  if (input.explicitProvider !== undefined) {
    return defaultModelSelection(input.explicitProvider);
  }
  if (input.projectDefaultModel !== null && input.projectDefaultModel !== undefined) {
    return input.projectDefaultModel;
  }
  return defaultModelSelection();
}

function paginateEntries<T>(
  entries: ReadonlyArray<T>,
  offset?: number,
  limit?: number,
): ReadonlyArray<T> {
  const safeOffset = Math.max(0, offset ?? 0);
  const sliced = entries.slice(safeOffset);
  return limit === undefined ? sliced : sliced.slice(0, Math.max(0, limit));
}

function deriveSessionType(thread: OrchestrationThread): SessionSummary["sessionType"] {
  if (thread.workflowId !== null && thread.parentThreadId === null) {
    return "workflow";
  }
  if (thread.parentThreadId !== null || thread.phaseRunId !== null || thread.role !== null) {
    return "agent";
  }
  return "chat";
}

function inferSessionType(input: {
  readonly parentThreadId: ThreadId | undefined;
  readonly workflowId: WorkflowId | undefined;
  readonly patternId: string | undefined;
}): "agent" | "workflow" | "chat" {
  if (input.parentThreadId !== undefined) {
    return "agent";
  }
  if (input.workflowId !== undefined) {
    return "workflow";
  }
  if (input.patternId !== undefined) {
    return "chat";
  }
  return "agent";
}

function deriveSessionStatus(input: {
  readonly thread: OrchestrationThread;
  readonly hasPendingRequest: boolean;
}): SessionStatus {
  if (input.hasPendingRequest) {
    return "needs-attention";
  }
  if (input.thread.archivedAt !== null) {
    return "cancelled";
  }

  switch (input.thread.session?.status) {
    case "starting":
    case "running":
      return "running";
    case "interrupted":
      return "paused";
    case "error":
      return "failed";
    case "stopped":
      return "cancelled";
    default:
      return input.thread.session === null ? "created" : "created";
  }
}

function toTranscriptEntry(message: OrchestrationThread["messages"][number]): TranscriptEntry {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    ...(message.attachments ? { attachments: message.attachments } : {}),
    turnId: message.turnId,
    streaming: message.streaming,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

function buildPendingThreadIds(snapshot: OrchestrationReadModel): ReadonlySet<string> {
  const pendingThreadIds = new Set<string>();
  for (const request of snapshot.pendingRequests) {
    if (request.status !== "pending") {
      continue;
    }
    pendingThreadIds.add(request.threadId);
    if (request.childThreadId !== undefined) {
      pendingThreadIds.add(request.childThreadId);
    }
  }
  return pendingThreadIds;
}

function toSessionSummary(
  thread: OrchestrationThread,
  pendingThreadIds: ReadonlySet<string>,
): SessionSummary {
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    sessionType: deriveSessionType(thread),
    title: thread.title,
    status: deriveSessionStatus({
      thread,
      hasPendingRequest: pendingThreadIds.has(thread.id),
    }),
    role: thread.role,
    provider: thread.modelSelection.provider,
    model: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    workflowId: thread.workflowId,
    currentPhaseId: thread.currentPhaseId,
    patternId: thread.patternId,
    branch: thread.branch,
    bootstrapStatus: thread.bootstrapStatus,
    childThreadIds: thread.childThreadIds,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
  };
}

function encodeError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function encodeResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function parseJsonRpcRequest(
  line: string,
):
  | { readonly ok: true; readonly request: JsonRpcRequest }
  | { readonly ok: false; readonly response: JsonRpcResponse } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {
      ok: false,
      response: encodeError(null, -32700, "Parse error"),
    };
  }

  if (Array.isArray(parsed) || typeof parsed !== "object" || parsed === null) {
    return {
      ok: false,
      response: encodeError(null, -32600, "Invalid Request"),
    };
  }

  const request = parsed as Record<string, unknown>;
  const id = request.id;
  const validId =
    id === undefined || id === null || typeof id === "string" || typeof id === "number";
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string" || !validId) {
    return {
      ok: false,
      response: encodeError(null, -32600, "Invalid Request"),
    };
  }

  return {
    ok: true,
    request: {
      id: id as JsonRpcId | undefined,
      method: request.method,
      params: request.params,
    },
  };
}

function decodeParams<A>(schema: Schema.Schema<A>, params: unknown, method: string): A {
  const decode = Schema.decodeUnknownSync(schema as never) as (input: unknown) => A;
  try {
    return decode(params ?? {}) as A;
  } catch (cause) {
    throw new OrchestrationGetSnapshotError({
      message: `Invalid params for '${method}'.`,
      cause: toError(cause),
    });
  }
}

function toSocketError(
  socketPath: string,
  operation: string,
  detail: string,
  cause: unknown,
): DaemonSocketError {
  return new DaemonSocketError({
    path: socketPath,
    operation,
    detail,
    cause: toError(cause),
  });
}

const makeSocketTransport = Effect.gen(function* () {
  const services = yield* Effect.services();
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const channelService = yield* ChannelService;
  const workflowRegistry = yield* WorkflowRegistry;
  const workspacePaths = yield* WorkspacePaths;

  const dispatchCommand = <A, E>(
    effect: Effect.Effect<A, E>,
    message: string,
  ): Effect.Effect<A, OrchestrationDispatchCommandError> =>
    effect.pipe(
      Effect.mapError((cause) =>
        Schema.is(OrchestrationDispatchCommandError)(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message,
              cause: toError(cause),
            }),
      ),
    );

  const dispatchSocketCommand = (command: unknown, message: string) =>
    dispatchCommand(
      orchestrationEngine.dispatch(
        command as unknown as Parameters<OrchestrationEngineShape["dispatch"]>[0],
      ),
      message,
    );

  const loadSnapshot = (
    message: string,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationGetSnapshotError> =>
    projectionSnapshotQuery.getSnapshot().pipe(
      Effect.mapError((cause) =>
        Schema.is(OrchestrationGetSnapshotError)(cause)
          ? cause
          : new OrchestrationGetSnapshotError({
              message,
              cause: toError(cause),
            }),
      ),
    );

  const requireThread = (
    snapshot: OrchestrationReadModel,
    threadId: ThreadId,
    message: string,
  ): Effect.Effect<OrchestrationThread, OrchestrationGetSnapshotError> => {
    const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
    return thread === undefined
      ? Effect.fail(
          new OrchestrationGetSnapshotError({
            message,
          }),
        )
      : Effect.succeed(thread);
  };

  const requireGateRequest = (
    snapshot: OrchestrationReadModel,
    threadId: ThreadId,
    phaseRunId: PhaseRunId,
  ): Effect.Effect<InteractiveRequest, OrchestrationDispatchCommandError> => {
    const request = snapshot.pendingRequests.find(
      (candidate) =>
        candidate.threadId === threadId &&
        candidate.type === "gate" &&
        candidate.status === "pending" &&
        ((candidate.phaseRunId !== undefined && candidate.phaseRunId === phaseRunId) ||
          ("phaseRunId" in candidate.payload && candidate.payload.phaseRunId === phaseRunId)),
    );

    return request === undefined
      ? Effect.fail(
          new OrchestrationDispatchCommandError({
            message: `No pending gate request found for thread '${threadId}' and phase run '${phaseRunId}'.`,
          }),
        )
      : Effect.succeed(request);
  };

  const resolveProjectContext = (input: {
    readonly projectId: ProjectId | undefined;
    readonly parentThreadId: ThreadId | undefined;
    readonly workspaceRoot: string | undefined;
    readonly model: ModelSelection | undefined;
    readonly provider: ProviderKind | undefined;
  }) =>
    Effect.gen(function* () {
      const snapshot = yield* loadSnapshot("Failed to resolve project context");

      if (input.projectId !== undefined) {
        const project = snapshot.projects.find((candidate) => candidate.id === input.projectId);
        if (project === undefined) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Project '${input.projectId}' was not found.`,
          });
        }
        return {
          projectId: project.id,
          modelSelection: resolveModelSelection({
            explicitModel: input.model,
            explicitProvider: input.provider,
            projectDefaultModel: project.defaultModelSelection,
          }),
        } as const;
      }

      if (input.parentThreadId !== undefined) {
        const parentThread = yield* requireThread(
          snapshot,
          input.parentThreadId,
          `Parent thread '${input.parentThreadId}' was not found.`,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
                ...(cause.cause ? { cause } : {}),
              }),
          ),
        );
        const project = snapshot.projects.find(
          (candidate) => candidate.id === parentThread.projectId,
        );
        if (project === undefined) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Project '${parentThread.projectId}' was not found for parent thread '${input.parentThreadId}'.`,
          });
        }
        return {
          projectId: project.id,
          modelSelection: resolveModelSelection({
            explicitModel: input.model,
            explicitProvider: input.provider,
            projectDefaultModel: project.defaultModelSelection,
          }),
        } as const;
      }

      if (input.workspaceRoot === undefined) {
        return yield* new OrchestrationDispatchCommandError({
          message: "thread.create requires projectId, parentThreadId, or workspaceRoot.",
        });
      }

      const normalizedWorkspaceRoot = yield* workspacePaths
        .normalizeWorkspaceRoot(input.workspaceRoot)
        .pipe(
          Effect.mapError((cause) => {
            if (
              Schema.is(WorkspaceRootNotExistsError)(cause) ||
              Schema.is(WorkspaceRootNotDirectoryError)(cause)
            ) {
              return new OrchestrationDispatchCommandError({
                message: cause.message,
                cause,
              });
            }
            return new OrchestrationDispatchCommandError({
              message: "Failed to normalize workspace root.",
              cause: toError(cause),
            });
          }),
        );

      const existingProject = yield* projectionSnapshotQuery
        .getActiveProjectByWorkspaceRoot(normalizedWorkspaceRoot)
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: "Failed to resolve project by workspace root.",
                cause: cause instanceof Error ? cause : new Error(String(cause)),
              }),
          ),
        );

      if (Option.isSome(existingProject)) {
        return {
          projectId: existingProject.value.id,
          modelSelection: resolveModelSelection({
            explicitModel: input.model,
            explicitProvider: input.provider,
            projectDefaultModel: existingProject.value.defaultModelSelection,
          }),
        } as const;
      }

      const projectId = randomProjectId();
      const resolvedModel = resolveModelSelection({
        explicitModel: input.model,
        explicitProvider: input.provider,
        projectDefaultModel: null,
      });
      const createdAt = nowIso();

      yield* dispatchSocketCommand(
        {
          type: "project.create",
          commandId: randomCommandId("project.create"),
          projectId,
          title: Path.basename(normalizedWorkspaceRoot) || "project",
          workspaceRoot: normalizedWorkspaceRoot,
          defaultModelSelection: resolvedModel,
          createdAt,
        },
        "Failed to create project for thread.create",
      );

      return {
        projectId,
        modelSelection: resolvedModel,
      } as const;
    });

  const handleThreadCreate = (params: unknown) =>
    Effect.gen(function* () {
      const input = decodeParams(ThreadCreateParams, params, "thread.create");
      const resolved = yield* resolveProjectContext({
        projectId: input.projectId,
        parentThreadId: input.parentThreadId,
        workspaceRoot: input.workspaceRoot,
        model: input.model,
        provider: input.provider,
      });
      const createdAt = nowIso();
      return yield* dispatchSocketCommand(
        {
          type: "thread.create",
          commandId: randomCommandId("thread.create"),
          threadId: randomThreadId(),
          projectId: resolved.projectId,
          ...(input.parentThreadId === undefined ? {} : { parentThreadId: input.parentThreadId }),
          ...(input.phaseRunId === undefined ? {} : { phaseRunId: input.phaseRunId }),
          sessionType: inferSessionType({
            parentThreadId: input.parentThreadId,
            workflowId: input.workflowId,
            patternId: input.patternId,
          }),
          title: input.title,
          description: input.description ?? "",
          ...(input.workflowId === undefined ? {} : { workflowId: input.workflowId }),
          ...(input.patternId === undefined ? {} : { patternId: input.patternId }),
          runtimeMode: input.runtimeMode ?? "full-access",
          model: resolved.modelSelection,
          ...(input.provider === undefined ? {} : { provider: input.provider }),
          ...(input.role === undefined ? {} : { role: input.role }),
          ...(input.branchOverride === undefined ? {} : { branchOverride: input.branchOverride }),
          ...(input.requiresWorktree === undefined
            ? {}
            : { requiresWorktree: input.requiresWorktree }),
          createdAt,
        },
        "Failed to create thread",
      );
    });

  const handleSessionCreate = (params: unknown) =>
    Effect.gen(function* () {
      const input = decodeParams(SessionCreateParams, params, "session.create");
      let workflowOption = Option.none<WorkflowDefinition>();
      if (input.workflow !== undefined) {
        workflowOption = yield* workflowRegistry.queryByName({ name: input.workflow }).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: "Failed to resolve workflow for session.create.",
                cause: cause instanceof Error ? cause : new Error(String(cause)),
              }),
          ),
        );
      }

      if (input.workflow !== undefined && Option.isNone(workflowOption)) {
        return yield* new OrchestrationDispatchCommandError({
          message: `Workflow '${input.workflow}' was not found.`,
        });
      }

      return yield* handleThreadCreate({
        workspaceRoot: input.projectPath,
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(Option.isSome(workflowOption) ? { workflowId: workflowOption.value.id } : {}),
      });
    });

  const handleTranscript = (threadId: ThreadId, offset?: number, limit?: number) =>
    Effect.gen(function* () {
      const snapshot = yield* loadSnapshot("Failed to load transcript");
      const thread = yield* requireThread(
        snapshot,
        threadId,
        `Failed to load transcript: thread '${threadId}' was not found.`,
      );

      const entries = paginateEntries(thread.messages.map(toTranscriptEntry), offset, limit);
      return {
        entries,
        total: thread.messages.length,
      };
    });

  const handleChildren = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const snapshot = yield* loadSnapshot("Failed to load child sessions");
      yield* requireThread(
        snapshot,
        threadId,
        `Failed to load child sessions: thread '${threadId}' was not found.`,
      );

      const pendingThreadIds = buildPendingThreadIds(snapshot);
      const children = snapshot.threads
        .filter((candidate) => candidate.parentThreadId === threadId)
        .map((candidate) => toSessionSummary(candidate, pendingThreadIds));

      return { children };
    });

  const handleSessionList = () =>
    Effect.gen(function* () {
      const snapshot = yield* loadSnapshot("Failed to list sessions");
      const pendingThreadIds = buildPendingThreadIds(snapshot);
      return snapshot.threads
        .filter((candidate) => candidate.parentThreadId === null)
        .map((candidate) => toSessionSummary(candidate, pendingThreadIds));
    });

  const handleSessionGet = (params: unknown) =>
    Effect.gen(function* () {
      const input = decodeParams(SessionIdParams, params, "session.get");
      const snapshot = yield* loadSnapshot("Failed to load session");
      const thread = yield* requireThread(
        snapshot,
        input.sessionId,
        `Failed to load session '${input.sessionId}'.`,
      );
      return toSessionSummary(thread, buildPendingThreadIds(snapshot));
    });

  const handleWorkflowList = () =>
    workflowRegistry.queryAll().pipe(
      Effect.map((workflows) => ({
        workflows: workflows.map(
          (workflow): WorkflowSummary => ({
            workflowId: workflow.id,
            name: workflow.name,
            description: workflow.description,
            builtIn: workflow.builtIn,
          }),
        ),
      })),
      Effect.mapError(
        (cause) =>
          new OrchestrationGetSnapshotError({
            message: "Failed to load workflows.",
            cause: cause instanceof Error ? cause : new Error(String(cause)),
          }),
      ),
    );

  const handleWorkflowGet = (params: unknown) =>
    Effect.gen(function* () {
      const input = decodeParams(WorkflowGetParams, params, "workflow.get");
      const workflowOption = yield* workflowRegistry
        .queryById({
          workflowId: input.workflowId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: "Failed to load workflow.",
                cause: cause instanceof Error ? cause : new Error(String(cause)),
              }),
          ),
        );
      if (Option.isNone(workflowOption)) {
        return yield* new OrchestrationGetSnapshotError({
          message: `Failed to load workflow '${input.workflowId}'.`,
        });
      }
      return {
        workflow: workflowOption.value,
      };
    });

  const handleGateApprove = (params: unknown) =>
    Effect.gen(function* () {
      const input = decodeParams(GateApproveParams, params, "gate.approve");
      const snapshot = yield* loadSnapshot("Failed to resolve gate request").pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
              ...(cause.cause ? { cause } : {}),
            }),
        ),
      );
      const request = yield* requireGateRequest(snapshot, input.threadId, input.phaseRunId);
      return yield* dispatchSocketCommand(
        {
          type: "request.resolve",
          commandId: randomCommandId("request.resolve"),
          requestId: request.id,
          resolvedWith: { decision: "approve" },
          createdAt: nowIso(),
        },
        "Failed to approve gate",
      );
    });

  const handleGateReject = (params: unknown) =>
    Effect.gen(function* () {
      const input = decodeParams(GateRejectParams, params, "gate.reject");
      const snapshot = yield* loadSnapshot("Failed to resolve gate request").pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
              ...(cause.cause ? { cause } : {}),
            }),
        ),
      );
      const request = yield* requireGateRequest(snapshot, input.threadId, input.phaseRunId);
      return yield* dispatchSocketCommand(
        {
          type: "request.resolve",
          commandId: randomCommandId("request.resolve"),
          requestId: request.id,
          resolvedWith: {
            decision: "reject",
            ...(input.correction === undefined ? {} : { correction: input.correction }),
          },
          createdAt: nowIso(),
        },
        "Failed to reject gate",
      );
    });

  const handleRequestResolve = (params: unknown) =>
    Effect.gen(function* () {
      const input = decodeParams(RequestResolveParams, params, "request.resolve");
      return yield* dispatchSocketCommand(
        {
          type: "request.resolve",
          commandId: randomCommandId("request.resolve"),
          requestId: input.requestId,
          resolvedWith: input.resolvedWith,
          createdAt: nowIso(),
        },
        "Failed to resolve interactive request",
      );
    });

  const handleChannelIntervene = (params: unknown) =>
    Effect.gen(function* () {
      const input = decodeParams(ChannelInterveneParams, params, "channel.intervene");
      return yield* dispatchSocketCommand(
        {
          type: "channel.post-message",
          commandId: randomCommandId("channel.post-message"),
          channelId: input.channelId,
          messageId: randomChannelMessageId(),
          fromType: "human",
          fromId: HUMAN_CHANNEL_PARTICIPANT_ID,
          ...(input.fromRole === undefined ? {} : { fromRole: input.fromRole }),
          content: input.content,
          createdAt: nowIso(),
        },
        "Failed to post channel intervention",
      );
    });

  const handlePhaseOutputUpdate = (params: unknown) =>
    Effect.gen(function* () {
      const input = decodeParams(PhaseOutputUpdateParams, params, "phaseOutput.update");
      return yield* dispatchSocketCommand(
        {
          type: "thread.edit-phase-output",
          commandId: randomCommandId("thread.edit-phase-output"),
          threadId: input.threadId,
          phaseRunId: input.phaseRunId,
          outputKey: input.outputKey,
          content: input.content,
          createdAt: nowIso(),
        },
        "Failed to update phase output",
      );
    });

  const registry = new Map<string, JsonRpcHandler>([
    [
      "daemon.ping",
      (_params) =>
        Effect.succeed({
          status: "ok" as const,
        }),
    ],
    [
      "daemon.stop",
      (params) =>
        Effect.sync(() => {
          decodeParams(EmptyParams, params, "daemon.stop");
          return null;
        }),
    ],
    ["session.list", () => handleSessionList()],
    ["session.get", (params) => handleSessionGet(params)],
    ["session.create", (params) => handleSessionCreate(params)],
    [
      "session.correct",
      (params) =>
        Effect.gen(function* () {
          const input = decodeParams(SessionCorrectParams, params, "session.correct");
          return yield* dispatchSocketCommand(
            {
              type: "thread.correct",
              commandId: randomCommandId("thread.correct"),
              threadId: input.sessionId,
              content: input.content,
              createdAt: nowIso(),
            },
            "Failed to queue session correction",
          );
        }),
    ],
    [
      "session.pause",
      (params) =>
        Effect.gen(function* () {
          const input = decodeParams(SessionIdParams, params, "session.pause");
          return yield* dispatchSocketCommand(
            {
              type: "thread.pause",
              commandId: randomCommandId("thread.pause"),
              threadId: input.sessionId,
              createdAt: nowIso(),
            },
            "Failed to pause session",
          );
        }),
    ],
    [
      "session.resume",
      (params) =>
        Effect.gen(function* () {
          const input = decodeParams(SessionIdParams, params, "session.resume");
          return yield* dispatchSocketCommand(
            {
              type: "thread.resume",
              commandId: randomCommandId("thread.resume"),
              threadId: input.sessionId,
              createdAt: nowIso(),
            },
            "Failed to resume session",
          );
        }),
    ],
    [
      "session.cancel",
      (params) =>
        Effect.gen(function* () {
          const input = decodeParams(SessionCancelParams, params, "session.cancel");
          return yield* dispatchSocketCommand(
            {
              type: "thread.cancel",
              commandId: randomCommandId("thread.cancel"),
              threadId: input.sessionId,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
              createdAt: nowIso(),
            },
            "Failed to cancel session",
          );
        }),
    ],
    [
      "session.sendTurn",
      (params) =>
        Effect.gen(function* () {
          const input = decodeParams(SessionSendTurnParams, params, "session.sendTurn");
          return yield* dispatchSocketCommand(
            {
              type: "thread.send-turn",
              commandId: randomCommandId("thread.send-turn"),
              threadId: input.sessionId,
              content: input.content,
              ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
              createdAt: nowIso(),
            },
            "Failed to send session turn",
          );
        }),
    ],
    [
      "session.getTranscript",
      (params) =>
        Effect.gen(function* () {
          const input = decodeParams(SessionTranscriptParams, params, "session.getTranscript");
          return yield* handleTranscript(input.sessionId, input.offset, input.limit);
        }),
    ],
    [
      "session.getChildren",
      (params) =>
        Effect.gen(function* () {
          const input = decodeParams(SessionIdParams, params, "session.getChildren");
          return yield* handleChildren(input.sessionId);
        }),
    ],
    ["thread.create", (params) => handleThreadCreate(params)],
    [
      "thread.correct",
      (params) =>
        Effect.gen(function* () {
          const input = decodeParams(ThreadCorrectParams, params, "thread.correct");
          return yield* dispatchSocketCommand(
            {
              type: "thread.correct",
              commandId: randomCommandId("thread.correct"),
              threadId: input.threadId,
              content: input.content,
              createdAt: nowIso(),
            },
            "Failed to queue thread correction",
          );
        }),
    ],
    [
      "thread.pause",
      (params) =>
        Effect.gen(function* () {
          const input = decodeParams(ThreadIdParams, params, "thread.pause");
          return yield* dispatchSocketCommand(
            {
              type: "thread.pause",
              commandId: randomCommandId("thread.pause"),
              threadId: input.threadId,
              createdAt: nowIso(),
            },
            "Failed to pause thread",
          );
        }),
    ],
    [
      "thread.resume",
      (params) =>
        Effect.gen(function* () {
          const input = decodeParams(ThreadIdParams, params, "thread.resume");
          return yield* dispatchSocketCommand(
            {
              type: "thread.resume",
              commandId: randomCommandId("thread.resume"),
              threadId: input.threadId,
              createdAt: nowIso(),
            },
            "Failed to resume thread",
          );
        }),
    ],
    [
      "thread.cancel",
      (params) =>
        Effect.gen(function* () {
          const input = decodeParams(ThreadCancelParams, params, "thread.cancel");
          return yield* dispatchSocketCommand(
            {
              type: "thread.cancel",
              commandId: randomCommandId("thread.cancel"),
              threadId: input.threadId,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
              createdAt: nowIso(),
            },
            "Failed to cancel thread",
          );
        }),
    ],
    [
      "thread.archive",
      (params) =>
        Effect.gen(function* () {
          const input = decodeParams(ThreadIdParams, params, "thread.archive");
          return yield* dispatchSocketCommand(
            {
              type: "thread.archive",
              commandId: randomCommandId("thread.archive"),
              threadId: input.threadId,
            },
            "Failed to archive thread",
          );
        }),
    ],
    [
      "thread.unarchive",
      (params) =>
        Effect.gen(function* () {
          const input = decodeParams(ThreadIdParams, params, "thread.unarchive");
          return yield* dispatchSocketCommand(
            {
              type: "thread.unarchive",
              commandId: randomCommandId("thread.unarchive"),
              threadId: input.threadId,
            },
            "Failed to unarchive thread",
          );
        }),
    ],
    [
      "thread.sendTurn",
      (params) =>
        Effect.gen(function* () {
          const input = decodeParams(ThreadSendTurnParams, params, "thread.sendTurn");
          return yield* dispatchSocketCommand(
            {
              type: "thread.send-turn",
              commandId: randomCommandId("thread.send-turn"),
              threadId: input.threadId,
              content: input.content,
              ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
              createdAt: nowIso(),
            },
            "Failed to send thread turn",
          );
        }),
    ],
    [
      "thread.getTranscript",
      (params) =>
        Effect.gen(function* () {
          const input = decodeParams(ThreadTranscriptParams, params, "thread.getTranscript");
          return yield* handleTranscript(input.threadId, input.offset, input.limit);
        }),
    ],
    [
      "thread.getChildren",
      (params) =>
        Effect.gen(function* () {
          const input = decodeParams(ThreadIdParams, params, "thread.getChildren");
          return yield* handleChildren(input.threadId);
        }),
    ],
    ["gate.approve", (params) => handleGateApprove(params)],
    ["gate.reject", (params) => handleGateReject(params)],
    ["request.resolve", (params) => handleRequestResolve(params)],
    [
      "channel.getMessages",
      (params) =>
        Effect.gen(function* () {
          const input = decodeParams(ChannelGetMessagesParams, params, "channel.getMessages");
          const messages = yield* channelService
            .getMessages({
              channelId: input.channelId,
              ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load channel messages.",
                    cause: cause instanceof Error ? cause : new Error(String(cause)),
                  }),
              ),
            );

          return {
            messages,
            total: messages.length,
          };
        }),
    ],
    [
      "channel.getChannel",
      (params) =>
        Effect.gen(function* () {
          const input = decodeParams(ChannelGetChannelParams, params, "channel.getChannel");
          const snapshot = yield* loadSnapshot("Failed to load channel");
          const channel = snapshot.channels.find((candidate) => candidate.id === input.channelId);
          if (channel === undefined) {
            return yield* new OrchestrationGetSnapshotError({
              message: `Failed to load channel '${input.channelId}'.`,
            });
          }
          return { channel };
        }),
    ],
    ["channel.intervene", (params) => handleChannelIntervene(params)],
    ["phaseOutput.update", (params) => handlePhaseOutputUpdate(params)],
    ["workflow.list", () => handleWorkflowList()],
    ["workflow.get", (params) => handleWorkflowGet(params)],
  ]);

  const bind: SocketTransportShape["bind"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        const startedAtMs =
          input.startedAt === undefined ? Date.now() : Date.parse(input.startedAt);
        const sockets = new Set<Net.Socket>();
        const server = Net.createServer((socket) => {
          sockets.add(socket);
          socket.setEncoding("utf8");

          let buffer = "";
          const writeResponse = (response: JsonRpcResponse) => {
            socket.write(`${JSON.stringify(response)}\n`);
          };

          socket.on("close", () => {
            sockets.delete(socket);
          });

          socket.on("data", (chunk) => {
            buffer += chunk;
            for (;;) {
              const newlineIndex = buffer.indexOf("\n");
              if (newlineIndex === -1) {
                break;
              }

              const line = buffer.slice(0, newlineIndex).trim();
              buffer = buffer.slice(newlineIndex + 1);

              if (line.length === 0) {
                continue;
              }

              const parsed = parseJsonRpcRequest(line);
              if (!parsed.ok) {
                writeResponse(parsed.response);
                continue;
              }

              const handler = registry.get(parsed.request.method);
              if (handler === undefined) {
                writeResponse(
                  encodeError(
                    parsed.request.id ?? null,
                    -32601,
                    `Method '${parsed.request.method}' not found`,
                  ),
                );
                continue;
              }

              let effect = handler(parsed.request.params);
              if (parsed.request.method !== "daemon.stop" && input.awaitReady !== undefined) {
                const handlerEffect = effect;
                effect = input.awaitReady.pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Daemon transport is not ready.",
                        cause: toError(cause),
                      }),
                  ),
                  Effect.flatMap(() => handlerEffect),
                );
              }
              if (parsed.request.method === "daemon.ping") {
                effect = Effect.map(effect, (result) => ({
                  ...(result as Record<string, unknown>),
                  uptime: Math.max(0, Date.now() - startedAtMs),
                }));
              }
              void Effect.runPromiseWith(services)(effect).then(
                (result) => {
                  if (parsed.request.id !== undefined) {
                    writeResponse(encodeResult(parsed.request.id, result));
                  }
                  if (parsed.request.method === "daemon.stop" && input.stopDaemon !== undefined) {
                    void Effect.runPromiseWith(services)(
                      input.stopDaemon!.pipe(
                        Effect.mapError(
                          (cause) =>
                            new OrchestrationGetSnapshotError({
                              message: "Failed to stop daemon.",
                              cause: toError(cause),
                            }),
                        ),
                        Effect.catch((error) =>
                          Effect.logWarning("daemon stop request failed after response", {
                            socketPath: input.socketPath,
                            cause: error,
                          }),
                        ),
                      ),
                    );
                  }
                },
                (cause) => {
                  const error =
                    Schema.is(OrchestrationDispatchCommandError)(cause) ||
                    Schema.is(OrchestrationGetSnapshotError)(cause)
                      ? cause
                      : new OrchestrationGetSnapshotError({
                          message: "Socket method failed.",
                          cause: toError(cause),
                        });

                  writeResponse(
                    encodeError(
                      parsed.request.id ?? null,
                      error.message.startsWith("Invalid params") ? -32602 : -32000,
                      error.message,
                    ),
                  );
                },
              );
            }
          });
        });

        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(input.socketPath, () => resolve());
        });
        await FSP.chmod(input.socketPath, SOCKET_PERMISSIONS);

        return {
          close: Effect.tryPromise({
            try: async () => {
              for (const socket of sockets) {
                socket.destroy();
              }
              await new Promise<void>((resolve, reject) => {
                server.close((error) => {
                  if (error) {
                    reject(error);
                    return;
                  }
                  resolve();
                });
              });
            },
            catch: (cause) =>
              toSocketError(
                input.socketPath,
                "close",
                "Failed to close daemon socket transport.",
                cause,
              ),
          }),
        };
      },
      catch: (cause) =>
        toSocketError(input.socketPath, "bind", "Failed to bind daemon socket transport.", cause),
    });

  return {
    bind,
  } satisfies SocketTransportShape;
});

export const SocketTransportLive = Layer.effect(SocketTransport, makeSocketTransport);
