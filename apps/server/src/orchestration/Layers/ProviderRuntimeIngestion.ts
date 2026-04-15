import { promises as nodeFs } from "node:fs";
import path from "node:path";

import {
  type AssistantDeliveryMode,
  CommandId,
  EventId,
  InteractiveRequestId,
  MessageId,
  type OrchestrationProposedPlanId,
  type OrchestrationThreadActivity,
  type OrchestrationToolInlineDiff,
  type ProviderRuntimeEvent,
  CheckpointRef,
  ThreadId,
  TurnId,
} from "@forgetools/contracts";
import { Cache, Cause, Effect, Layer, Option, Stream } from "effect";
import { makeDrainableWorker } from "@forgetools/shared/DrainableWorker";
import { findLatestProposedPlanById } from "@forgetools/shared/threadHistory";
import {
  asArray,
  asRecord,
  asString,
  asTrimmedString,
  truncateDetail,
} from "@forgetools/shared/narrowing";
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
import {
  classifyOrchestrationActivityPresentation,
  shouldPersistOrchestrationActivity,
} from "@forgetools/shared/orchestrationActivityPresentation";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { buildToolInlineDiffArtifact } from "../toolDiffArtifacts.ts";
import { classifyToolDiffPaths, filterUnifiedDiffByPaths } from "../toolDiffPaths.ts";
import {
  buildCommandExecutionInlineDiffArtifact,
  parseSupportedShellMutationCommand,
  type CapturedShellMutationOperation,
} from "../commandInlineDiffArtifacts.ts";
import { appendServerDebugRecord, resolveServerDebugLogPath } from "../../debug.ts";
import { DEBUG_BACKGROUND_TASKS } from "../../provider/adapterUtils.ts";

import {
  extractActivityInlineDiff,
  runtimeEventToActivities,
  upgradeActivitiesFromExactTurnDiff,
} from "./runtimeIngestion/activityMapping.ts";
import {
  type TurnStartRequestedDomainEvent,
  type RuntimeIngestionInput,
  type PendingCommandInlineDiff,
  TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
  TURN_MESSAGE_IDS_BY_TURN_TTL,
  BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
  BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
  MAX_BUFFERED_ASSISTANT_CHARS,
  STRICT_PROVIDER_LIFECYCLE_GUARD,
  providerTurnKey,
  providerCommandId,
  toTurnId,
  sameId,
  normalizeProposedPlanMarkdown,
  proposedPlanIdForTurn,
  proposedPlanIdFromEvent,
  mergeDiffFilesByPath,
  mapUnifiedDiffToCheckpointFiles,
  extractRuntimeToolCommand,
  extractRuntimeCommandExitCode,
  hasDependentShellMutationPaths,
  pendingCommandInlineDiffKey,
  orchestrationSessionStatusFromRuntimeState,
  normalizeRuntimeTurnState,
  extractChildThreadAttribution,
} from "./runtimeIngestion/helpers.ts";

appendServerDebugRecord({
  topic: "background",
  source: "ingestion",
  label: "startup",
  details: {
    debugEnabled: DEBUG_BACKGROUND_TASKS,
    logPath: resolveServerDebugLogPath(),
  },
});

const bufferedAssistantChunkKey = (event: ProviderRuntimeEvent): string =>
  String(event.itemId ?? event.turnId ?? event.eventId);

function interactiveRequestTypeFromRuntimeEvent(
  event: ProviderRuntimeEvent,
): "approval" | "user-input" | "permission" | "mcp-elicitation" | undefined {
  if (
    event.type === "request.opened" ||
    event.type === "request.resolved" ||
    event.type === "user-input.requested" ||
    event.type === "user-input.resolved"
  ) {
    const requestType =
      event.type === "user-input.requested" || event.type === "user-input.resolved"
        ? "tool_user_input"
        : event.payload.requestType;
    switch (requestType) {
      case "command_execution_approval":
      case "file_read_approval":
      case "file_change_approval":
      case "apply_patch_approval":
      case "exec_command_approval":
        return "approval";
      case "tool_user_input":
        return "user-input";
      case "permission_approval":
        return "permission";
      case "mcp_elicitation":
        return "mcp-elicitation";
      default:
        return undefined;
    }
  }
  return undefined;
}

function isCodexControlCollabTool(toolName: string | null | undefined): boolean {
  return toolName === "sendInput" || toolName === "wait";
}

function normalizeCodexCollabAgentTerminalStatus(
  status: string | null | undefined,
): "running" | "completed" | "failed" {
  switch (status) {
    case "completed":
    case "shutdown":
      return "completed";
    case "failed":
    case "errored":
    case "interrupted":
    case "notFound":
      return "failed";
    default:
      return "running";
  }
}

function toMcpElicitationQuestions(value: unknown):
  | Array<{
      id: string;
      header: string;
      question: string;
      options: Array<{ label: string; description: string }>;
      multiSelect?: boolean | undefined;
    }>
  | undefined {
  const questions = asArray(value);
  if (!questions) {
    return undefined;
  }

  const parsedQuestions = questions
    .map((entry) => {
      const question = asRecord(entry);
      if (!question) {
        return undefined;
      }
      const id = asTrimmedString(question.id);
      const header = asTrimmedString(question.header);
      const prompt = asTrimmedString(question.question);
      const options = asArray(question.options)
        ?.map((option) => {
          const optionRecord = asRecord(option);
          const label = asTrimmedString(optionRecord?.label);
          const description = asTrimmedString(optionRecord?.description);
          if (!label || !description) {
            return undefined;
          }
          return { label, description };
        })
        .filter((option): option is { label: string; description: string } => option !== undefined);
      if (!id || !header || !prompt || !options || options.length === 0) {
        return undefined;
      }
      const parsedQuestion: {
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description: string }>;
        multiSelect?: boolean | undefined;
      } = {
        id,
        header,
        question: prompt,
        options,
      };
      if (question.multiSelect === true) {
        parsedQuestion.multiSelect = true;
      }
      return parsedQuestion;
    })
    .filter(
      (
        question,
      ): question is {
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description: string }>;
        multiSelect?: boolean | undefined;
      } => question !== undefined,
    );

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
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
  const assistantChunkKeysByTurnKey = yield* Cache.make<string, Set<string>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<string>()),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  const pendingCommandInlineDiffs = new Map<string, PendingCommandInlineDiff>();
  type BufferedAssistantChunk = {
    readonly chunkKey: string;
    readonly createdAt: string;
    readonly threadId: ThreadId;
    readonly turnId?: TurnId;
    readonly text: string;
    readonly updatedAt: string;
  };
  const bufferedAssistantChunkByThreadId = new Map<ThreadId, BufferedAssistantChunk>();
  const dispatchForgeCommand = (command: unknown) =>
    orchestrationEngine.dispatch(command as Parameters<typeof orchestrationEngine.dispatch>[0]);
  const interactiveRequestIdFromRuntimeEvent = (
    event: ProviderRuntimeEvent,
  ): InteractiveRequestId | undefined =>
    event.requestId ? InteractiveRequestId.makeUnsafe(String(event.requestId)) : undefined;

  const interactiveRequestPayloadFromRuntimeEvent = (
    event: Extract<ProviderRuntimeEvent, { type: "request.opened" | "user-input.requested" }>,
  ) => {
    if (event.type === "user-input.requested") {
      return {
        type: "user-input" as const,
        questions: event.payload.questions,
      };
    }

    const requestType = interactiveRequestTypeFromRuntimeEvent(event);
    const args = asRecord(event.payload.args);
    const requestArgs = args ?? {};
    switch (requestType) {
      case "approval":
        return {
          type: "approval" as const,
          requestType: event.payload.requestType,
          detail: event.payload.detail ?? "",
          toolName:
            event.payload.requestType === "apply_patch_approval"
              ? "apply_patch"
              : event.payload.requestType === "exec_command_approval"
                ? "exec_command"
                : event.payload.requestType === "file_read_approval"
                  ? "file_read"
                  : event.payload.requestType === "file_change_approval"
                    ? "file_change"
                    : "command_execution",
          toolInput: requestArgs,
        };
      case "permission":
        return {
          type: "permission" as const,
          reason: typeof requestArgs.reason === "string" ? requestArgs.reason : null,
          permissions:
            asRecord(requestArgs.permissions) !== undefined
              ? requestArgs.permissions
              : {
                  network: null,
                  fileSystem: null,
                },
        };
      case "mcp-elicitation": {
        const serverName = asTrimmedString(requestArgs.serverName) ?? "mcp";
        const message = asString(requestArgs.message) ?? "";
        const meta = requestArgs._meta ?? requestArgs.meta ?? null;
        const questions = toMcpElicitationQuestions(requestArgs.questions);
        if (requestArgs.mode === "url") {
          return {
            type: "mcp-elicitation" as const,
            mode: "url" as const,
            serverName,
            message,
            meta,
            url: asString(requestArgs.url) ?? "",
            elicitationId: asTrimmedString(requestArgs.elicitationId) ?? "elicitation",
            ...(event.turnId ? { turnId: String(event.turnId) } : {}),
          };
        }
        return {
          type: "mcp-elicitation" as const,
          mode: "form" as const,
          serverName,
          message,
          meta,
          requestedSchema: requestArgs.requestedSchema ?? {},
          ...(questions ? { questions } : {}),
          ...(event.turnId ? { turnId: String(event.turnId) } : {}),
        };
      }
      default:
        return undefined;
    }
  };

  const interactiveRequestResolutionFromRuntimeEvent = (
    event: Extract<ProviderRuntimeEvent, { type: "request.resolved" | "user-input.resolved" }>,
  ) => {
    if (event.type === "user-input.resolved") {
      return {
        answers: event.payload.answers,
      };
    }

    const requestType = interactiveRequestTypeFromRuntimeEvent(event);
    const resolution = asRecord(event.payload.resolution);
    if (!resolution) {
      return undefined;
    }
    switch (requestType) {
      case "approval":
        return typeof resolution.decision === "string"
          ? {
              decision: resolution.decision,
              ...(Array.isArray(resolution.updatedPermissions)
                ? { updatedPermissions: resolution.updatedPermissions }
                : {}),
            }
          : undefined;
      case "user-input":
        return asRecord(resolution.answers)
          ? {
              answers: resolution.answers,
            }
          : undefined;
      case "permission":
        return {
          scope: resolution.scope === "session" ? "session" : "turn",
          permissions: asRecord(resolution.permissions) ?? {},
        };
      case "mcp-elicitation":
        return typeof resolution.action === "string"
          ? {
              action: resolution.action,
              content: resolution.content ?? null,
              meta: resolution.meta ?? resolution._meta ?? null,
            }
          : undefined;
      default:
        return undefined;
    }
  };

  const syncInteractiveRequestFromRuntimeEvent = Effect.fn(
    "syncInteractiveRequestFromRuntimeEvent",
  )(function* (
    threadId: ThreadId,
    event: Extract<
      ProviderRuntimeEvent,
      {
        type:
          | "request.opened"
          | "request.resolved"
          | "user-input.requested"
          | "user-input.resolved";
      }
    >,
  ) {
    const requestId = interactiveRequestIdFromRuntimeEvent(event);
    if (!requestId) {
      return;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const pendingRequest = readModel.pendingRequests.find((request) => request.id === requestId);

    if (event.type === "request.opened" || event.type === "user-input.requested") {
      if (pendingRequest) {
        return;
      }
      const requestType = interactiveRequestTypeFromRuntimeEvent(event);
      const payload = interactiveRequestPayloadFromRuntimeEvent(event);
      if (!requestType || !payload) {
        return;
      }
      yield* dispatchForgeCommand({
        type: "request.open",
        commandId: providerCommandId(event, "request-open"),
        requestId,
        threadId,
        requestType,
        payload,
        createdAt: event.createdAt,
      });
      return;
    }

    if (!pendingRequest) {
      return;
    }

    const resolution = interactiveRequestResolutionFromRuntimeEvent(event);
    if (resolution) {
      yield* dispatchForgeCommand({
        type: "request.resolve",
        commandId: providerCommandId(event, "request-resolve"),
        requestId,
        resolvedWith: resolution,
        createdAt: event.createdAt,
      });
      return;
    }

    yield* dispatchForgeCommand({
      type: "request.mark-stale",
      commandId: providerCommandId(event, "request-stale"),
      requestId,
      reason: "Provider cleared pending request without a client resolution.",
      createdAt: event.createdAt,
    });
  });

  const synthesizeCodexSubagentLifecycleActivities = (input: {
    readonly existingActivities: ReadonlyArray<OrchestrationThreadActivity>;
    readonly currentActivities: ReadonlyArray<OrchestrationThreadActivity>;
  }): OrchestrationThreadActivity[] => {
    const startsByChildKey = new Set<string>();
    const completionsByChildKey = new Set<string>();
    const knownChildThreadIds = new Set<string>();

    for (const activity of [...input.existingActivities, ...input.currentActivities]) {
      const payload = asRecord(activity.payload);
      const childAttr = asRecord(payload?.childThreadAttribution);
      const childProviderThreadId = asTrimmedString(childAttr?.childProviderThreadId);
      if (childProviderThreadId) {
        knownChildThreadIds.add(childProviderThreadId);
      }

      const taskId = asTrimmedString(childAttr?.taskId) ?? asTrimmedString(payload?.taskId);
      if (!taskId || !childProviderThreadId) {
        continue;
      }

      const childKey = `${taskId}\u001f${childProviderThreadId}`;
      if (activity.kind === "task.started") {
        startsByChildKey.add(childKey);
        continue;
      }
      if (activity.kind === "task.completed") {
        completionsByChildKey.add(childKey);
        continue;
      }
      if (activity.kind === "task.updated") {
        const patch = asRecord(payload?.patch);
        const patchStatus = asTrimmedString(patch?.status);
        if (patchStatus === "completed" || patchStatus === "failed" || patchStatus === "killed") {
          completionsByChildKey.add(childKey);
        }
      }
    }

    const syntheticActivities: OrchestrationThreadActivity[] = [];
    for (const activity of input.currentActivities) {
      if (
        activity.kind !== "tool.started" &&
        activity.kind !== "tool.updated" &&
        activity.kind !== "tool.completed"
      ) {
        continue;
      }
      const payload = asRecord(activity.payload);
      if (payload?.itemType !== "collab_agent_tool_call" || payload.childThreadAttribution) {
        continue;
      }

      const data = asRecord(payload.data);
      const item = asRecord(data?.item);
      const toolName = asTrimmedString(item?.tool);
      const taskId = asTrimmedString(item?.id);
      const receiverThreadIds =
        asArray(item?.receiverThreadIds)
          ?.map((value) => asTrimmedString(value))
          .filter((value): value is string => value != null) ?? [];
      if (!taskId || receiverThreadIds.length === 0) {
        continue;
      }

      const label = asTrimmedString(item?.prompt)?.slice(0, 120);
      const agentModel = asTrimmedString(item?.model) ?? undefined;
      const agentsStates = asRecord(item?.agentsStates);

      for (const childProviderThreadId of receiverThreadIds) {
        const childKey = `${taskId}\u001f${childProviderThreadId}`;
        if (toolName === "spawnAgent" && !startsByChildKey.has(childKey)) {
          startsByChildKey.add(childKey);
          syntheticActivities.push({
            id: EventId.makeUnsafe(
              `${activity.id}:synthetic-subagent-start:${childProviderThreadId}`,
            ),
            tone: "info",
            kind: "task.started",
            summary: "Task started",
            payload: {
              taskId,
              childThreadAttribution: {
                taskId,
                childProviderThreadId,
                ...(label ? { label } : {}),
                ...(agentModel ? { agentModel } : {}),
              },
            },
            turnId: activity.turnId,
            createdAt: activity.createdAt,
          });
        }

        if (completionsByChildKey.has(childKey)) {
          continue;
        }
        if (isCodexControlCollabTool(toolName) && !knownChildThreadIds.has(childProviderThreadId)) {
          continue;
        }

        const agentState = asRecord(agentsStates?.[childProviderThreadId]);
        const normalizedStatus = normalizeCodexCollabAgentTerminalStatus(
          asTrimmedString(agentState?.status),
        );
        if (normalizedStatus === "running") {
          continue;
        }

        completionsByChildKey.add(childKey);
        syntheticActivities.push({
          id: EventId.makeUnsafe(
            `${activity.id}:synthetic-subagent-complete:${childProviderThreadId}`,
          ),
          tone: normalizedStatus === "failed" ? "error" : "info",
          kind: "task.completed",
          summary: normalizedStatus === "failed" ? "Task failed" : "Task completed",
          payload: {
            taskId,
            status: normalizedStatus === "failed" ? "failed" : "completed",
            childThreadAttribution: {
              taskId,
              childProviderThreadId,
              ...(label ? { label } : {}),
              ...(agentModel ? { agentModel } : {}),
            },
          },
          turnId: activity.turnId,
          createdAt: activity.createdAt,
        });
      }
    }

    return syntheticActivities;
  };

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

  const captureCommandInlineDiffAtStart = Effect.fn("captureCommandInlineDiffAtStart")(function* (
    event: Extract<ProviderRuntimeEvent, { type: "item.started" }>,
  ) {
    const turnId = toTurnId(event.turnId);
    if (!event.itemId || event.payload.itemType !== "command_execution") {
      return undefined;
    }

    const workspaceCwd = yield* resolveWorkspaceCwdForThread(event.threadId);
    if (!workspaceCwd) {
      return undefined;
    }

    const command = extractRuntimeToolCommand(event.payload.data);
    if (!command) {
      pendingCommandInlineDiffs.delete(pendingCommandInlineDiffKey(event.threadId, event.itemId));
      return undefined;
    }

    const parsed = parseSupportedShellMutationCommand({
      command,
      workspaceRoot: workspaceCwd,
      ...(process.env.WSL_DISTRO_NAME ? { wslDistroName: process.env.WSL_DISTRO_NAME } : {}),
    });
    if (!parsed) {
      pendingCommandInlineDiffs.delete(pendingCommandInlineDiffKey(event.threadId, event.itemId));
      return undefined;
    }

    if (hasDependentShellMutationPaths(parsed.operations)) {
      pendingCommandInlineDiffs.delete(pendingCommandInlineDiffKey(event.threadId, event.itemId));
      return undefined;
    }

    const capturedOperations: CapturedShellMutationOperation[] = [];
    for (const operation of parsed.operations) {
      if (operation.kind === "delete") {
        const absolutePath = path.join(workspaceCwd, operation.path);
        const stat = yield* Effect.tryPromise(() => nodeFs.lstat(absolutePath)).pipe(
          Effect.catch(() => Effect.void),
        );
        if (stat?.isDirectory()) {
          pendingCommandInlineDiffs.delete(
            pendingCommandInlineDiffKey(event.threadId, event.itemId),
          );
          return undefined;
        }
        const originalContent =
          stat && stat.isFile()
            ? yield* Effect.tryPromise(() => nodeFs.readFile(absolutePath, "utf8")).pipe(
                Effect.catch(() => Effect.void),
              )
            : undefined;
        capturedOperations.push({
          kind: "delete",
          path: operation.path,
          ...(originalContent !== undefined ? { originalContent } : {}),
        });
        continue;
      }

      const absoluteOldPath = path.join(workspaceCwd, operation.oldPath);
      const absoluteNewPath = path.join(workspaceCwd, operation.newPath);
      const sourceStat = yield* Effect.tryPromise(() => nodeFs.lstat(absoluteOldPath)).pipe(
        Effect.catch(() => Effect.void),
      );
      if (sourceStat?.isDirectory()) {
        pendingCommandInlineDiffs.delete(pendingCommandInlineDiffKey(event.threadId, event.itemId));
        return undefined;
      }
      const destinationStat = yield* Effect.tryPromise(() => nodeFs.lstat(absoluteNewPath)).pipe(
        Effect.catch(() => Effect.void),
      );
      if (destinationStat !== undefined) {
        pendingCommandInlineDiffs.delete(pendingCommandInlineDiffKey(event.threadId, event.itemId));
        return undefined;
      }
      const sourceIsFile = sourceStat?.isFile() ?? false;
      capturedOperations.push(
        sourceIsFile
          ? {
              kind: "rename",
              oldPath: operation.oldPath,
              newPath: operation.newPath,
            }
          : {
              kind: "rename",
              oldPath: operation.oldPath,
              newPath: operation.newPath,
              exact: false,
            },
      );
    }

    const inlineDiff = buildCommandExecutionInlineDiffArtifact({
      operations: capturedOperations,
    });
    if (!inlineDiff) {
      pendingCommandInlineDiffs.delete(pendingCommandInlineDiffKey(event.threadId, event.itemId));
      return undefined;
    }

    pendingCommandInlineDiffs.set(pendingCommandInlineDiffKey(event.threadId, event.itemId), {
      threadId: event.threadId,
      ...(turnId ? { turnId } : {}),
      itemId: event.itemId,
      normalizedCommand: parsed.normalizedCommand,
      inlineDiff,
    });

    return inlineDiff;
  });

  const takePendingCommandInlineDiff = (
    threadId: ThreadId,
    itemId: string | undefined,
  ): OrchestrationToolInlineDiff | undefined => {
    if (!itemId) {
      return undefined;
    }
    const key = pendingCommandInlineDiffKey(threadId, itemId);
    const pending = pendingCommandInlineDiffs.get(key);
    pendingCommandInlineDiffs.delete(key);
    return pending?.inlineDiff;
  };

  const clearPendingCommandInlineDiffsForTurn = (
    threadId: ThreadId,
    turnId: TurnId | undefined,
  ): void => {
    if (!turnId) {
      return;
    }
    for (const [key, pending] of pendingCommandInlineDiffs.entries()) {
      if (pending.threadId === threadId && sameId(pending.turnId, turnId)) {
        pendingCommandInlineDiffs.delete(key);
      }
    }
  };

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
        .getLatestByTurnId({
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

  const getCompleteTurnDiffForTurn = Effect.fn("getCompleteTurnDiffForTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) {
    const existingDiffOption = yield* projectionAgentDiffRepository
      .getLatestByTurnId({
        threadId: input.threadId,
        turnId: input.turnId,
      })
      .pipe(Effect.catch(() => Effect.succeed(Option.none())));
    if (Option.isNone(existingDiffOption)) {
      return undefined;
    }
    if (
      existingDiffOption.value.coverage !== "complete" ||
      existingDiffOption.value.diff.trim().length === 0
    ) {
      return undefined;
    }
    return existingDiffOption.value.diff;
  });

  const upsertThreadActivities = Effect.fn("upsertThreadActivities")(function* (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  }) {
    yield* Effect.forEach(input.activities, (activity) =>
      orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: providerCommandId(input.event, "thread-activity-append"),
        threadId: input.threadId,
        activity,
        createdAt: activity.createdAt,
      }),
    ).pipe(Effect.asVoid);
  });

  const upsertThreadActivityInlineDiffs = Effect.fn("upsertThreadActivityInlineDiffs")(
    function* (input: {
      readonly event: ProviderRuntimeEvent;
      readonly threadId: ThreadId;
      readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
    }) {
      const activityInlineDiffs = input.activities.flatMap((activity) => {
        const inlineDiff = extractActivityInlineDiff(activity);
        return inlineDiff ? [{ activityId: activity.id, inlineDiff }] : [];
      });
      yield* Effect.forEach(
        activityInlineDiffs,
        ({ activityId, inlineDiff }) =>
          orchestrationEngine.dispatch({
            type: "thread.activity.inline-diff.upsert",
            commandId: providerCommandId(input.event, "thread-activity-inline-diff-upsert"),
            threadId: input.threadId,
            activityId,
            inlineDiff,
            createdAt: input.event.createdAt,
          }),
        { discard: true },
      );
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

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const rememberAssistantChunkKeyForTurn = (threadId: ThreadId, turnId: TurnId, chunkKey: string) =>
    Cache.getOption(assistantChunkKeysByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingChunkKeys) =>
        Cache.set(
          assistantChunkKeysByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingChunkKeys, {
            onNone: () => new Set([chunkKey]),
            onSome: (chunkKeys) => {
              const nextChunkKeys = new Set(chunkKeys);
              nextChunkKeys.add(chunkKey);
              return nextChunkKeys;
            },
          }),
        ),
      ),
    );

  const getAssistantChunkKeysForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(assistantChunkKeysByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingChunkKeys) =>
        Option.getOrElse(existingChunkKeys, (): Set<string> => new Set<string>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const clearAssistantChunkKeysForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(assistantChunkKeysByTurnKey, providerTurnKey(threadId, turnId));

  const bufferedAssistantMessageId = (chunkKey: string, boundaryEventId: string): MessageId =>
    MessageId.makeUnsafe(`assistant:${chunkKey}:flush:${boundaryEventId}`);

  const clearBufferedAssistantChunk = (threadId: ThreadId) => {
    bufferedAssistantChunkByThreadId.delete(threadId);
  };

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

  const emitBufferedAssistantChunk = Effect.fn("emitBufferedAssistantChunk")(function* (input: {
    event: ProviderRuntimeEvent;
    chunk: BufferedAssistantChunk;
    commandTag: string;
    threadId: ThreadId;
  }) {
    if (input.chunk.text.length === 0) {
      clearBufferedAssistantChunk(input.threadId);
      return undefined;
    }

    const messageId = bufferedAssistantMessageId(input.chunk.chunkKey, input.event.eventId);
    if (input.chunk.turnId) {
      yield* rememberAssistantMessageId(input.threadId, input.chunk.turnId, messageId);
      yield* rememberAssistantChunkKeyForTurn(
        input.threadId,
        input.chunk.turnId,
        input.chunk.chunkKey,
      );
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: providerCommandId(input.event, input.commandTag),
      threadId: input.threadId,
      messageId,
      text: input.chunk.text,
      ...(input.chunk.turnId ? { turnId: input.chunk.turnId } : {}),
      createdAt: input.event.createdAt,
      updatedAt: input.event.createdAt,
    });
    clearBufferedAssistantChunk(input.threadId);
    return messageId;
  });

  const flushBufferedAssistantChunkForBoundary = Effect.fn(
    "flushBufferedAssistantChunkForBoundary",
  )(function* (threadId: ThreadId, event: ProviderRuntimeEvent, commandTag: string) {
    const chunk = bufferedAssistantChunkByThreadId.get(threadId);
    if (!chunk) {
      return undefined;
    }
    return yield* emitBufferedAssistantChunk({
      event,
      chunk,
      commandTag,
      threadId,
    });
  });

  const bufferAssistantTextDelta = Effect.fn("bufferAssistantTextDelta")(function* (input: {
    delta: string;
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId?: TurnId;
  }) {
    const chunkKey = bufferedAssistantChunkKey(input.event);
    const existingChunk = bufferedAssistantChunkByThreadId.get(input.threadId);
    if (existingChunk && existingChunk.chunkKey !== chunkKey) {
      yield* emitBufferedAssistantChunk({
        event: input.event,
        chunk: existingChunk,
        commandTag: "assistant-buffer-source-switch",
        threadId: input.threadId,
      });
    }

    const activeChunk = bufferedAssistantChunkByThreadId.get(input.threadId);
    const nextChunk: BufferedAssistantChunk =
      activeChunk && activeChunk.chunkKey === chunkKey
        ? {
            ...activeChunk,
            text: `${activeChunk.text}${input.delta}`,
            updatedAt: input.event.createdAt,
          }
        : {
            chunkKey,
            createdAt: input.event.createdAt,
            threadId: input.threadId,
            ...(input.turnId ? { turnId: input.turnId } : {}),
            text: input.delta,
            updatedAt: input.event.createdAt,
          };

    if (nextChunk.text.length > MAX_BUFFERED_ASSISTANT_CHARS) {
      bufferedAssistantChunkByThreadId.set(input.threadId, nextChunk);
      yield* emitBufferedAssistantChunk({
        event: input.event,
        chunk: nextChunk,
        commandTag: "assistant-buffer-spill",
        threadId: input.threadId,
      });
      return;
    }

    bufferedAssistantChunkByThreadId.set(input.threadId, nextChunk);
  });

  const upsertProposedPlan = Effect.fn("upsertProposedPlan")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      updatedAt: string;
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

    const existingPlan = findLatestProposedPlanById(input.threadProposedPlans, input.planId);
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
      updatedAt: string;
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

        yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
        yield* Cache.invalidate(assistantChunkKeysByTurnKey, key);
      }),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
    clearBufferedAssistantChunk(threadId);
    yield* Effect.forEach(
      proposedPlanKeys,
      (key) =>
        key.startsWith(proposedPlanPrefix)
          ? Cache.invalidate(bufferedProposedPlanById, key)
          : Effect.void,
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
    for (const [key, pending] of pendingCommandInlineDiffs.entries()) {
      if (pending.threadId === threadId) {
        pendingCommandInlineDiffs.delete(key);
      }
    }
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
      const sourcePlan = sourceThread
        ? findLatestProposedPlanById(sourceThread.proposedPlans, sourcePlanId)
        : undefined;
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

    if (
      event.type === "request.opened" ||
      event.type === "request.resolved" ||
      event.type === "user-input.requested" ||
      event.type === "user-input.resolved"
    ) {
      yield* syncInteractiveRequestFromRuntimeEvent(thread.id, event);
    }

    const now = event.createdAt;
    const eventTurnId = toTurnId(event.turnId);
    const activeTurnId = thread.session?.activeTurnId ?? null;
    const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
      serverSettingsService.getSettings,
      (settings) => (settings.enableAssistantStreaming ? "streaming" : "buffered"),
    );
    const assistantDelta =
      event.type === "content.delta" && event.payload.streamKind === "assistant_text"
        ? event.payload.delta
        : undefined;
    const proposedPlanDelta =
      event.type === "turn.proposed.delta" ? event.payload.delta : undefined;
    let flushedBufferedAssistantMessageId: MessageId | undefined;
    const flushBufferedAssistantChunkAtBoundary = Effect.fn(
      "flushBufferedAssistantChunkAtBoundary",
    )(function* () {
      if (
        flushedBufferedAssistantMessageId !== undefined ||
        assistantDeliveryMode !== "buffered" ||
        assistantDelta !== undefined
      ) {
        return flushedBufferedAssistantMessageId;
      }
      flushedBufferedAssistantMessageId = yield* flushBufferedAssistantChunkForBoundary(
        thread.id,
        event,
        "assistant-buffer-boundary",
      );
      return flushedBufferedAssistantMessageId;
    });

    const conflictsWithActiveTurn =
      activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
    const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;
    const childThreadAttribution =
      "payload" in event ? extractChildThreadAttribution(event.payload) : undefined;
    const isChildThreadAssistantEvent =
      childThreadAttribution !== undefined &&
      ((event.type === "content.delta" && event.payload.streamKind === "assistant_text") ||
        (event.type === "item.completed" && event.payload.itemType === "assistant_message"));

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

    if (assistantDelta && assistantDelta.length > 0 && !isChildThreadAssistantEvent) {
      const turnId = toTurnId(event.turnId);
      if (assistantDeliveryMode === "buffered") {
        yield* bufferAssistantTextDelta({
          delta: assistantDelta,
          event,
          threadId: thread.id,
          ...(turnId ? { turnId } : {}),
        });
      } else {
        const assistantMessageId = MessageId.makeUnsafe(
          `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
        );
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }
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
      event.type === "item.completed" &&
      event.payload.itemType === "assistant_message" &&
      !isChildThreadAssistantEvent
        ? {
            chunkKey: bufferedAssistantChunkKey(event),
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
      yield* flushBufferedAssistantChunkAtBoundary();
      const turnId = toTurnId(event.turnId);
      const existingAssistantChunkKeys =
        turnId !== undefined
          ? yield* getAssistantChunkKeysForTurn(thread.id, turnId)
          : new Set<string>();
      const completionMessageAlreadyExists = thread.messages.some(
        (entry) => entry.id === assistantCompletion.messageId,
      );
      if (assistantDeliveryMode === "streaming") {
        const assistantMessageId = assistantCompletion.messageId;
        const shouldEmitCompletionText =
          assistantCompletion.fallbackText !== undefined && !completionMessageAlreadyExists;
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: providerCommandId(event, "assistant-complete"),
          threadId: thread.id,
          messageId: assistantMessageId,
          ...(shouldEmitCompletionText ? { text: assistantCompletion.fallbackText } : {}),
          ...(turnId ? { turnId } : {}),
          createdAt: now,
          updatedAt: now,
        });
      } else {
        const shouldEmitFallbackAssistantMessage =
          assistantCompletion.fallbackText !== undefined &&
          flushedBufferedAssistantMessageId === undefined &&
          !existingAssistantChunkKeys.has(assistantCompletion.chunkKey);

        if (shouldEmitFallbackAssistantMessage) {
          const assistantMessageId = assistantCompletion.messageId;
          if (turnId) {
            yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
            yield* rememberAssistantChunkKeyForTurn(
              thread.id,
              turnId,
              assistantCompletion.chunkKey,
            );
          }
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: providerCommandId(event, "assistant-complete-fallback"),
            threadId: thread.id,
            messageId: assistantMessageId,
            text: assistantCompletion.fallbackText,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    }

    if (proposedPlanCompletion) {
      yield* flushBufferedAssistantChunkAtBoundary();
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
      yield* flushBufferedAssistantChunkAtBoundary();
      const turnId = toTurnId(event.turnId);
      if (turnId) {
        yield* clearAssistantMessageIdsForTurn(thread.id, turnId);
        yield* clearAssistantChunkKeysForTurn(thread.id, turnId);

        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          threadProposedPlans: thread.proposedPlans,
          planId: proposedPlanIdForTurn(thread.id, turnId),
          turnId,
          updatedAt: now,
        });
        clearPendingCommandInlineDiffsForTurn(thread.id, turnId);
      }
    }

    if (event.type === "session.exited") {
      yield* flushBufferedAssistantChunkAtBoundary();
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
          .getLatestByTurnId({
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

    let itemInlineDiff: OrchestrationToolInlineDiff | undefined;

    if (event.type === "item.started" && event.payload.itemType === "command_execution") {
      yield* captureCommandInlineDiffAtStart(event);
    }

    if (
      (event.type === "item.updated" || event.type === "item.completed") &&
      event.payload.itemType === "file_change"
    ) {
      const workspaceCwd = yield* resolveWorkspaceCwdForThread(thread.id);
      itemInlineDiff = buildToolInlineDiffArtifact({
        provider: event.provider,
        payloadData: event.payload.data,
        ...(workspaceCwd ? { workspaceRoot: workspaceCwd } : {}),
      });
    }

    if (event.type === "item.completed" && event.payload.itemType === "command_execution") {
      const exitCode = extractRuntimeCommandExitCode(event.payload.data);
      itemInlineDiff =
        exitCode === 0 ? takePendingCommandInlineDiff(thread.id, event.itemId) : undefined;
      if (exitCode !== 0) {
        takePendingCommandInlineDiff(thread.id, event.itemId);
      }
    }

    if (itemInlineDiff) {
      yield* refreshTurnAgentDiffFromToolArtifact({
        event,
        thread,
        inlineDiff: itemInlineDiff,
      });
    }

    const turnId = toTurnId(event.turnId);
    let activities = runtimeEventToActivities(
      event,
      itemInlineDiff ? { inlineDiff: itemInlineDiff } : undefined,
    );

    if (
      isChildThreadAssistantEvent &&
      event.type === "item.completed" &&
      event.payload.itemType === "assistant_message" &&
      typeof event.payload.detail === "string" &&
      event.payload.detail.trim().length > 0
    ) {
      const childItemId = event.itemId ?? undefined;
      const childResponseAlreadyRecorded = childItemId
        ? [...thread.activities, ...activities].some((activity) => {
            if (activity.kind !== "task.progress") {
              return false;
            }
            const payload = asRecord(activity.payload);
            if (payload?.itemType !== "assistant_message" || payload?.itemId !== childItemId) {
              return false;
            }
            return (
              extractChildThreadAttribution(payload)?.childProviderThreadId ===
              childThreadAttribution?.childProviderThreadId
            );
          })
        : false;
      if (!childResponseAlreadyRecorded) {
        activities = [
          ...activities,
          {
            id: EventId.makeUnsafe(`${event.eventId}:child-assistant-complete`),
            createdAt: event.createdAt,
            tone: "info",
            kind: "task.progress",
            summary: "Subagent response",
            payload: {
              taskId:
                typeof childThreadAttribution?.taskId === "string"
                  ? childThreadAttribution.taskId
                  : (event.itemId ?? "subagent-response"),
              itemType: "assistant_message",
              ...(event.itemId ? { itemId: event.itemId } : {}),
              detail: truncateDetail(event.payload.detail),
              ...(childThreadAttribution ? { childThreadAttribution } : {}),
            },
            turnId: turnId ?? null,
          },
        ];
      }
    }

    if (event.provider === "codex") {
      const syntheticActivities = synthesizeCodexSubagentLifecycleActivities({
        existingActivities: thread.activities,
        currentActivities: activities,
      });
      if (syntheticActivities.length > 0) {
        activities = [...activities, ...syntheticActivities];
      }
    }

    if (event.provider === "codex" && turnId) {
      const workspaceCwd = yield* resolveWorkspaceCwdForThread(thread.id);
      if (workspaceCwd) {
        if (
          (event.type === "item.updated" || event.type === "item.completed") &&
          event.payload.itemType === "file_change"
        ) {
          const exactTurnDiff = yield* getCompleteTurnDiffForTurn({
            threadId: thread.id,
            turnId,
          });
          if (exactTurnDiff) {
            activities = upgradeActivitiesFromExactTurnDiff({
              activitiesToUpgrade: activities,
              activityContext: [...thread.activities, ...activities],
              turnId,
              workspaceRoot: workspaceCwd,
              unifiedDiff: exactTurnDiff,
            });
          }
        }

        if (event.type === "turn.diff.updated") {
          const upgradedExistingActivities = upgradeActivitiesFromExactTurnDiff({
            activitiesToUpgrade: thread.activities,
            activityContext: thread.activities,
            turnId,
            workspaceRoot: workspaceCwd,
            unifiedDiff: event.payload.unifiedDiff,
          }).filter((activity, index) => activity !== thread.activities[index]);

          if (upgradedExistingActivities.length > 0) {
            yield* upsertThreadActivityInlineDiffs({
              event,
              threadId: thread.id,
              activities: upgradedExistingActivities,
            });
          }
        }
      }
    }

    const persistedActivities = activities.filter(shouldPersistOrchestrationActivity);

    if (
      persistedActivities.some(
        (activity) => classifyOrchestrationActivityPresentation(activity).assistantBoundary,
      )
    ) {
      yield* flushBufferedAssistantChunkAtBoundary();
    }

    yield* upsertThreadActivities({
      event,
      threadId: thread.id,
      activities: persistedActivities,
    });
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
