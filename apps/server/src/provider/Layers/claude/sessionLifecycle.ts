/**
 * Session lifecycle operations for the Claude adapter.
 *
 * Manages session start/stop, turn submission, thread read/rollback/fork,
 * approval request handling, and stream fiber lifecycle.
 *
 * @module claude/sessionLifecycle
 */
import {
  type CanUseTool,
  forkSession,
  type Options as ClaudeQueryOptions,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  ClaudeCodeEffort,
  type ProviderApprovalDecision,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@forgetools/contracts";
import { resolveApiModelId, resolveEffort } from "@forgetools/shared/model";
import { Cause, Deferred, Effect, Exit, Fiber, Queue, Random, Ref, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../../Errors.ts";
import type { ClaudeAdapterShape } from "../../Services/ClaudeAdapter.ts";
import { CLAUDE_SESSION_ERROR_MATCHERS, toMessage, toRequestError } from "../../adapterUtils.ts";
import { getClaudeModelCapabilities } from "../ClaudeProvider.ts";
import { getPendingMcpServer } from "../../pendingMcpServers.ts";

import {
  asCanonicalTurnId,
  asRuntimeRequestId,
  extractExitPlanModePlan,
  getEffectiveClaudeCodeEffort,
  interruptionMessageFromClaudeCause,
  isClaudeInterruptedCause,
  messageFromClaudeStreamCause,
  nativeProviderRefs,
  readClaudeResumeState,
  toError,
} from "./sdkMessageParsing.ts";
import { classifyRequestType, summarizeToolRequest } from "./toolClassification.ts";
import { buildUserMessageEffect, CLAUDE_SETTING_SOURCES } from "./messageBuilding.ts";
import {
  completeTurn,
  emitProposedPlanCompleted,
  emitRuntimeError,
  handleSdkMessage,
  snapshotThread,
  updateResumeCursor,
} from "./streamHandlers.ts";
import {
  PROVIDER,
  type ActiveSubagentTool,
  type ClaudeAdapterContext,
  type ClaudeSessionContext,
  type ClaudeTurnState,
  type PendingApproval,
  type PendingUserInput,
  type PromptQueueItem,
  type StartSessionServices,
  type ToolInFlight,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Stream lifecycle
// ---------------------------------------------------------------------------

export const runSdkStream = (
  ctx: ClaudeAdapterContext,
  context: ClaudeSessionContext,
): Effect.Effect<void, Error> =>
  Stream.fromAsyncIterable(context.query, (cause) =>
    toError(cause, "Claude runtime stream failed."),
  ).pipe(
    Stream.takeWhile(() => !context.stopped),
    Stream.runForEach((message) => handleSdkMessage(ctx, context, message)),
  );

export const handleStreamExit = Effect.fn("handleStreamExit")(function* (
  ctx: ClaudeAdapterContext,
  context: ClaudeSessionContext,
  exit: Exit.Exit<void, Error>,
) {
  if (context.stopped) {
    return;
  }

  if (Exit.isFailure(exit)) {
    if (isClaudeInterruptedCause(exit.cause)) {
      if (context.turnState) {
        yield* completeTurn(
          ctx,
          context,
          "interrupted",
          interruptionMessageFromClaudeCause(exit.cause),
        );
      }
    } else {
      const message = messageFromClaudeStreamCause(exit.cause, "Claude runtime stream failed.");
      yield* emitRuntimeError(ctx, context, message, Cause.pretty(exit.cause));
      yield* completeTurn(ctx, context, "failed", message);
    }
  } else if (context.turnState) {
    yield* completeTurn(ctx, context, "interrupted", "Claude runtime stream ended.");
  }

  yield* stopSessionInternal(ctx, context, {
    emitExitEvent: true,
  });
});

// ---------------------------------------------------------------------------
// Session stop
// ---------------------------------------------------------------------------

export const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
  ctx: ClaudeAdapterContext,
  context: ClaudeSessionContext,
  options?: { readonly emitExitEvent?: boolean },
) {
  if (context.stopped) return;

  context.stopped = true;

  for (const [requestId, pending] of context.pendingApprovals) {
    yield* Deferred.succeed(pending.decision, "cancel");
    const stamp = yield* ctx.makeEventStamp();
    yield* ctx.offerRuntimeEvent({
      type: "request.resolved",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      requestId: asRuntimeRequestId(requestId),
      payload: {
        requestType: pending.requestType,
        decision: "cancel",
      },
      providerRefs: nativeProviderRefs(context),
    });
  }
  context.pendingApprovals.clear();

  if (context.turnState) {
    yield* completeTurn(ctx, context, "interrupted", "Session stopped.");
  }

  yield* Queue.shutdown(context.promptQueue);

  const streamFiber = context.streamFiber;
  context.streamFiber = undefined;
  if (streamFiber && streamFiber.pollUnsafe() === undefined) {
    yield* Fiber.interrupt(streamFiber);
  }

  // @effect-diagnostics-next-line tryCatchInEffectGen:off
  try {
    context.query.close();
  } catch (cause) {
    yield* emitRuntimeError(ctx, context, "Failed to close Claude runtime query.", cause);
  }

  const updatedAt = yield* ctx.nowIso;
  context.session = {
    ...context.session,
    status: "closed",
    activeTurnId: undefined,
    updatedAt,
  };

  if (options?.emitExitEvent !== false) {
    const stamp = yield* ctx.makeEventStamp();
    yield* ctx.offerRuntimeEvent({
      type: "session.exited",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      payload: {
        reason: "Session stopped",
        exitKind: "graceful",
      },
      providerRefs: {},
    });
  }

  ctx.sessions.delete(context.session.threadId);
});

// ---------------------------------------------------------------------------
// Session lookup
// ---------------------------------------------------------------------------

export const requireSession = (
  sessions: Map<ThreadId, ClaudeSessionContext>,
  threadId: ThreadId,
): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> => {
  const context = sessions.get(threadId);
  if (!context) {
    return Effect.fail(
      new ProviderAdapterSessionNotFoundError({
        provider: PROVIDER,
        threadId,
      }),
    );
  }
  if (context.stopped || context.session.status === "closed") {
    return Effect.fail(
      new ProviderAdapterSessionClosedError({
        provider: PROVIDER,
        threadId,
      }),
    );
  }
  return Effect.succeed(context);
};

// ---------------------------------------------------------------------------
// Session start
// ---------------------------------------------------------------------------

export const startSession = (
  ctx: ClaudeAdapterContext,
  services: StartSessionServices,
): ClaudeAdapterShape["startSession"] =>
  Effect.fn("startSession")(function* (input) {
    if (input.provider !== undefined && input.provider !== PROVIDER) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
      });
    }

    const startedAt = yield* ctx.nowIso;
    const resumeState = readClaudeResumeState(input.resumeCursor);
    const threadId = input.threadId;
    const existingResumeSessionId = resumeState?.resume;
    const newSessionId =
      existingResumeSessionId === undefined ? yield* Random.nextUUIDv4 : undefined;
    const sessionId = existingResumeSessionId ?? newSessionId;

    const runtimeServices = yield* Effect.services();
    const runFork = Effect.runForkWith(runtimeServices);
    const runPromise = Effect.runPromiseWith(runtimeServices);

    const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
    const prompt = Stream.fromQueue(promptQueue).pipe(
      Stream.filter((item) => item.type === "message"),
      Stream.map((item) => item.message),
      Stream.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
      ),
      Stream.toAsyncIterable,
    );

    const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
    const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
    const inFlightTools = new Map<number, ToolInFlight>();
    const activeSubagentTools = new Map<string, ActiveSubagentTool>();

    const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);

    /**
     * Handle AskUserQuestion tool calls by emitting a `user-input.requested`
     * runtime event and waiting for the user to respond via `respondToUserInput`.
     */
    const handleAskUserQuestion = Effect.fn("handleAskUserQuestion")(function* (
      context: ClaudeSessionContext,
      toolInput: Record<string, unknown>,
      callbackOptions: { readonly signal: AbortSignal; readonly toolUseID?: string },
    ) {
      const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);

      // Parse questions from the SDK's AskUserQuestion input.
      const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
      const questions: Array<UserInputQuestion> = rawQuestions.map(
        (q: Record<string, unknown>, idx: number) => ({
          id: typeof q.header === "string" ? q.header : `q-${idx}`,
          header: typeof q.header === "string" ? q.header : `Question ${idx + 1}`,
          question: typeof q.question === "string" ? q.question : "",
          options: Array.isArray(q.options)
            ? q.options.map((opt: Record<string, unknown>) => ({
                label: typeof opt.label === "string" ? opt.label : "",
                description: typeof opt.description === "string" ? opt.description : "",
              }))
            : [],
          multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : false,
        }),
      );

      const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
      let aborted = false;
      const pendingInput: PendingUserInput = {
        questions,
        answers: answersDeferred,
      };

      // Emit user-input.requested so the UI can present the questions.
      const requestedStamp = yield* ctx.makeEventStamp();
      yield* ctx.offerRuntimeEvent({
        type: "user-input.requested",
        eventId: requestedStamp.eventId,
        provider: PROVIDER,
        createdAt: requestedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: { questions },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: callbackOptions.toolUseID,
        }),
        raw: {
          source: "claude.sdk.permission",
          method: "canUseTool/AskUserQuestion",
          payload: { toolName: "AskUserQuestion", input: toolInput },
        },
      });

      pendingUserInputs.set(requestId, pendingInput);

      // Handle abort (e.g. turn interrupted while waiting for user input).
      const onAbort = () => {
        if (!pendingUserInputs.has(requestId)) {
          return;
        }
        aborted = true;
        pendingUserInputs.delete(requestId);
        runFork(Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers));
      };
      callbackOptions.signal.addEventListener("abort", onAbort, { once: true });

      // Block until the user provides answers.
      const answers = yield* Deferred.await(answersDeferred);
      pendingUserInputs.delete(requestId);

      // Emit user-input.resolved so the UI knows the interaction completed.
      const resolvedStamp = yield* ctx.makeEventStamp();
      yield* ctx.offerRuntimeEvent({
        type: "user-input.resolved",
        eventId: resolvedStamp.eventId,
        provider: PROVIDER,
        createdAt: resolvedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: { answers },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: callbackOptions.toolUseID,
        }),
        raw: {
          source: "claude.sdk.permission",
          method: "canUseTool/AskUserQuestion/resolved",
          payload: { answers },
        },
      });

      if (aborted) {
        return {
          behavior: "deny",
          message: "User cancelled tool execution.",
        } satisfies PermissionResult;
      }

      // Return the answers to the SDK in the expected format:
      // { questions: [...], answers: { questionText: selectedLabel } }
      return {
        behavior: "allow",
        updatedInput: {
          questions: toolInput.questions,
          answers,
        },
      } satisfies PermissionResult;
    });

    const canUseToolEffect = Effect.fn("canUseTool")(function* (
      toolName: Parameters<CanUseTool>[0],
      toolInput: Parameters<CanUseTool>[1],
      callbackOptions: Parameters<CanUseTool>[2],
    ) {
      const context = yield* Ref.get(contextRef);
      if (!context) {
        return {
          behavior: "deny",
          message: "Claude session context is unavailable.",
        } satisfies PermissionResult;
      }

      // Handle AskUserQuestion: surface clarifying questions to the
      // user via the user-input runtime event channel, regardless of
      // runtime mode (plan mode relies on this heavily).
      if (toolName === "AskUserQuestion") {
        return yield* handleAskUserQuestion(context, toolInput, callbackOptions);
      }

      if (toolName === "ExitPlanMode") {
        const planMarkdown = extractExitPlanModePlan(toolInput);
        if (planMarkdown) {
          yield* emitProposedPlanCompleted(ctx, context, {
            planMarkdown,
            toolUseId: callbackOptions.toolUseID,
            rawSource: "claude.sdk.permission",
            rawMethod: "canUseTool/ExitPlanMode",
            rawPayload: {
              toolName,
              input: toolInput,
            },
          });
        }

        return {
          behavior: "deny",
          message:
            "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
        } satisfies PermissionResult;
      }

      const runtimeMode = input.runtimeMode ?? "full-access";
      if (runtimeMode === "full-access") {
        return {
          behavior: "allow",
          updatedInput: toolInput,
        } satisfies PermissionResult;
      }

      const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
      const requestType = classifyRequestType(toolName);
      const detail = summarizeToolRequest(toolName, toolInput);
      const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
      const pendingApproval: PendingApproval = {
        requestType,
        detail,
        decision: decisionDeferred,
        ...(callbackOptions.suggestions ? { suggestions: callbackOptions.suggestions } : {}),
      };

      const requestedStamp = yield* ctx.makeEventStamp();
      yield* ctx.offerRuntimeEvent({
        type: "request.opened",
        eventId: requestedStamp.eventId,
        provider: PROVIDER,
        createdAt: requestedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: {
          requestType,
          detail,
          args: {
            toolName,
            input: toolInput,
            ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: callbackOptions.toolUseID,
        }),
        raw: {
          source: "claude.sdk.permission",
          method: "canUseTool/request",
          payload: {
            toolName,
            input: toolInput,
          },
        },
      });

      pendingApprovals.set(requestId, pendingApproval);

      const onAbort = () => {
        if (!pendingApprovals.has(requestId)) {
          return;
        }
        pendingApprovals.delete(requestId);
        runFork(Deferred.succeed(decisionDeferred, "cancel"));
      };

      callbackOptions.signal.addEventListener("abort", onAbort, {
        once: true,
      });

      const decision = yield* Deferred.await(decisionDeferred);
      pendingApprovals.delete(requestId);

      const resolvedStamp = yield* ctx.makeEventStamp();
      yield* ctx.offerRuntimeEvent({
        type: "request.resolved",
        eventId: resolvedStamp.eventId,
        provider: PROVIDER,
        createdAt: resolvedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: {
          requestType,
          decision,
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: callbackOptions.toolUseID,
        }),
        raw: {
          source: "claude.sdk.permission",
          method: "canUseTool/decision",
          payload: {
            decision,
          },
        },
      });

      if (decision === "accept" || decision === "acceptForSession") {
        return {
          behavior: "allow",
          updatedInput: toolInput,
          ...(decision === "acceptForSession" && pendingApproval.suggestions
            ? { updatedPermissions: [...pendingApproval.suggestions] }
            : {}),
        } satisfies PermissionResult;
      }

      return {
        behavior: "deny",
        message:
          decision === "cancel"
            ? "User cancelled tool execution."
            : "User declined tool execution.",
      } satisfies PermissionResult;
    });

    const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
      runPromise(canUseToolEffect(toolName, toolInput, callbackOptions));

    const claudeSettings = yield* services.serverSettingsService.getSettings.pipe(
      Effect.map((settings) => settings.providers.claudeAgent),
      Effect.mapError(
        (error) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: error.message,
            cause: error,
          }),
      ),
    );
    const claudeBinaryPath = claudeSettings.binaryPath;
    const modelSelection =
      input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;
    const caps = getClaudeModelCapabilities(modelSelection?.model);
    const apiModelId = modelSelection ? resolveApiModelId(modelSelection) : undefined;
    const effort = (resolveEffort(caps, modelSelection?.options?.effort) ??
      null) as ClaudeCodeEffort | null;
    const fastMode = modelSelection?.options?.fastMode === true && caps.supportsFastMode;
    const thinking =
      typeof modelSelection?.options?.thinking === "boolean" && caps.supportsThinkingToggle
        ? modelSelection.options.thinking
        : undefined;
    const effectiveEffort = getEffectiveClaudeCodeEffort(effort);
    const permissionMode = input.runtimeMode === "full-access" ? "bypassPermissions" : undefined;
    const settings = {
      ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
      ...(fastMode ? { fastMode: true } : {}),
    };

    const pendingMcp = getPendingMcpServer(threadId);

    const oauthToken = yield* services.oauthResolver.getToken;

    const queryOptions: ClaudeQueryOptions = {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(apiModelId ? { model: apiModelId } : {}),
      pathToClaudeCodeExecutable: claudeBinaryPath,
      settingSources: [...CLAUDE_SETTING_SOURCES],
      ...(effectiveEffort ? { effort: effectiveEffort } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
      ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
      ...(newSessionId ? { sessionId: newSessionId } : {}),
      includePartialMessages: true,
      canUseTool,
      env: {
        ...process.env,
        ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
      },
      ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
      ...(pendingMcp ? { mcpServers: pendingMcp.config } : {}),
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
    } as ClaudeQueryOptions;

    const queryRuntime = yield* Effect.try({
      try: () =>
        services.createQuery({
          prompt,
          options: queryOptions,
        }),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId,
          detail: toMessage(cause, "Failed to start Claude runtime session."),
          cause,
        }),
    });

    const session: ProviderSession = {
      threadId,
      provider: PROVIDER,
      status: "ready",
      runtimeMode: input.runtimeMode,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(modelSelection?.model ? { model: modelSelection.model } : {}),
      ...(threadId ? { threadId } : {}),
      resumeCursor: {
        ...(threadId ? { threadId } : {}),
        ...(sessionId ? { resume: sessionId } : {}),
        ...(resumeState?.resumeSessionAt ? { resumeSessionAt: resumeState.resumeSessionAt } : {}),
        turnCount: resumeState?.turnCount ?? 0,
      },
      createdAt: startedAt,
      updatedAt: startedAt,
    };

    const context: ClaudeSessionContext = {
      session,
      promptQueue,
      query: queryRuntime,
      streamFiber: undefined,
      startedAt,
      basePermissionMode: permissionMode,
      currentApiModelId: apiModelId,
      resumeSessionId: sessionId,
      pendingApprovals,
      pendingUserInputs,
      turns: [],
      inFlightTools,
      activeSubagentTools,
      turnState: undefined,
      lastKnownContextWindow: undefined,
      lastKnownTokenUsage: undefined,
      lastAssistantUuid: resumeState?.resumeSessionAt,
      lastThreadStartedId: undefined,
      stopped: false,
    };
    yield* Ref.set(contextRef, context);
    ctx.sessions.set(threadId, context);

    const sessionStartedStamp = yield* ctx.makeEventStamp();
    yield* ctx.offerRuntimeEvent({
      type: "session.started",
      eventId: sessionStartedStamp.eventId,
      provider: PROVIDER,
      createdAt: sessionStartedStamp.createdAt,
      threadId,
      payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
      providerRefs: {},
    });

    const configuredStamp = yield* ctx.makeEventStamp();
    yield* ctx.offerRuntimeEvent({
      type: "session.configured",
      eventId: configuredStamp.eventId,
      provider: PROVIDER,
      createdAt: configuredStamp.createdAt,
      threadId,
      payload: {
        config: {
          ...(apiModelId ? { model: apiModelId } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(effectiveEffort ? { effort: effectiveEffort } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(fastMode ? { fastMode: true } : {}),
        },
      },
      providerRefs: {},
    });

    const readyStamp = yield* ctx.makeEventStamp();
    yield* ctx.offerRuntimeEvent({
      type: "session.state.changed",
      eventId: readyStamp.eventId,
      provider: PROVIDER,
      createdAt: readyStamp.createdAt,
      threadId,
      payload: {
        state: "ready",
      },
      providerRefs: {},
    });

    let streamFiber: Fiber.Fiber<void, never>;
    streamFiber = runFork(
      Effect.exit(runSdkStream(ctx, context)).pipe(
        Effect.flatMap((exit) => {
          if (context.stopped) {
            return Effect.void;
          }
          if (context.streamFiber === streamFiber) {
            context.streamFiber = undefined;
          }
          return handleStreamExit(ctx, context, exit);
        }),
      ),
    );
    context.streamFiber = streamFiber;
    streamFiber.addObserver(() => {
      if (context.streamFiber === streamFiber) {
        context.streamFiber = undefined;
      }
    });

    return {
      ...session,
    };
  });

// ---------------------------------------------------------------------------
// Turn operations
// ---------------------------------------------------------------------------

export const sendTurn = (
  ctx: ClaudeAdapterContext,
  services: Pick<StartSessionServices, "fileSystem" | "serverConfig">,
): ClaudeAdapterShape["sendTurn"] =>
  Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(ctx.sessions, input.threadId);
    const modelSelection =
      input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;

    if (context.turnState) {
      // Auto-close a stale synthetic turn (from background agent responses
      // between user prompts) to prevent blocking the user's next turn.
      yield* completeTurn(ctx, context, "completed");
    }

    if (modelSelection?.model) {
      const apiModelId = resolveApiModelId(modelSelection);
      if (context.currentApiModelId !== apiModelId) {
        yield* Effect.tryPromise({
          try: () => context.query.setModel(apiModelId),
          catch: (cause) =>
            toRequestError(
              PROVIDER,
              input.threadId,
              "turn/setModel",
              cause,
              CLAUDE_SESSION_ERROR_MATCHERS,
            ),
        });
        context.currentApiModelId = apiModelId;
      }
      context.session = {
        ...context.session,
        model: modelSelection.model,
      };
    }

    // Apply interaction mode by switching the SDK's permission mode.
    // "plan" maps directly to the SDK's "plan" permission mode;
    // "default" restores the session's original permission mode.
    // When interactionMode is absent we leave the current mode unchanged.
    if (input.interactionMode === "plan") {
      yield* Effect.tryPromise({
        try: () => context.query.setPermissionMode("plan"),
        catch: (cause) =>
          toRequestError(
            PROVIDER,
            input.threadId,
            "turn/setPermissionMode",
            cause,
            CLAUDE_SESSION_ERROR_MATCHERS,
          ),
      });
    } else if (input.interactionMode === "default") {
      yield* Effect.tryPromise({
        try: () =>
          context.query.setPermissionMode(context.basePermissionMode ?? "bypassPermissions"),
        catch: (cause) =>
          toRequestError(
            PROVIDER,
            input.threadId,
            "turn/setPermissionMode",
            cause,
            CLAUDE_SESSION_ERROR_MATCHERS,
          ),
      });
    }

    const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
    const turnState: ClaudeTurnState = {
      turnId,
      startedAt: yield* ctx.nowIso,
      items: [],
      assistantTextBlocks: new Map(),
      assistantTextBlockOrder: [],
      capturedProposedPlanKeys: new Set(),
      agentDiffPatchesByToolUseId: new Map(),
      agentDiffCoverage: "complete",
      lastEmittedUnifiedDiff: null,
      nextSyntheticAssistantBlockIndex: -1,
    };

    const updatedAt = yield* ctx.nowIso;
    context.turnState = turnState;
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt,
    };

    const turnStartedStamp = yield* ctx.makeEventStamp();
    yield* ctx.offerRuntimeEvent({
      type: "turn.started",
      eventId: turnStartedStamp.eventId,
      provider: PROVIDER,
      createdAt: turnStartedStamp.createdAt,
      threadId: context.session.threadId,
      turnId,
      payload: modelSelection?.model ? { model: modelSelection.model } : {},
      providerRefs: {},
    });

    const message = yield* buildUserMessageEffect(input, {
      fileSystem: services.fileSystem,
      attachmentsDir: services.serverConfig.attachmentsDir,
    });

    yield* Queue.offer(context.promptQueue, {
      type: "message",
      message,
    }).pipe(
      Effect.mapError((cause) =>
        toRequestError(
          PROVIDER,
          input.threadId,
          "turn/start",
          cause,
          CLAUDE_SESSION_ERROR_MATCHERS,
        ),
      ),
    );

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

// ---------------------------------------------------------------------------
// Remaining adapter operations
// ---------------------------------------------------------------------------

export const interruptTurn = (ctx: ClaudeAdapterContext): ClaudeAdapterShape["interruptTurn"] =>
  Effect.fn("interruptTurn")(function* (threadId, _turnId) {
    const context = yield* requireSession(ctx.sessions, threadId);
    yield* Effect.tryPromise({
      try: () => context.query.interrupt(),
      catch: (cause) =>
        toRequestError(PROVIDER, threadId, "turn/interrupt", cause, CLAUDE_SESSION_ERROR_MATCHERS),
    });
  });

export const readThread = (ctx: ClaudeAdapterContext): ClaudeAdapterShape["readThread"] =>
  Effect.fn("readThread")(function* (threadId) {
    const context = yield* requireSession(ctx.sessions, threadId);
    return yield* snapshotThread(context);
  });

export const rollbackThread = (ctx: ClaudeAdapterContext): ClaudeAdapterShape["rollbackThread"] =>
  Effect.fn("rollbackThread")(function* (threadId, numTurns) {
    const context = yield* requireSession(ctx.sessions, threadId);
    const nextLength = Math.max(0, context.turns.length - numTurns);
    context.turns.splice(nextLength);
    yield* updateResumeCursor(ctx, context);
    return yield* snapshotThread(context);
  });

export const respondToRequest = (
  ctx: ClaudeAdapterContext,
): ClaudeAdapterShape["respondToRequest"] =>
  Effect.fn("respondToRequest")(function* (threadId, requestId, decision) {
    const context = yield* requireSession(ctx.sessions, threadId);
    const pending = context.pendingApprovals.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/requestApproval/decision",
        detail: `Unknown pending approval request: ${requestId}`,
      });
    }

    context.pendingApprovals.delete(requestId);
    yield* Deferred.succeed(pending.decision, decision);
  });

export const respondToUserInput = (
  ctx: ClaudeAdapterContext,
): ClaudeAdapterShape["respondToUserInput"] =>
  Effect.fn("respondToUserInput")(function* (threadId, requestId, answers) {
    const context = yield* requireSession(ctx.sessions, threadId);
    const pending = context.pendingUserInputs.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/tool/respondToUserInput",
        detail: `Unknown pending user-input request: ${requestId}`,
      });
    }

    context.pendingUserInputs.delete(requestId);
    yield* Deferred.succeed(pending.answers, answers);
  });

export const forkThread = (ctx: ClaudeAdapterContext): ClaudeAdapterShape["forkThread"] =>
  Effect.fn("forkThread")(function* (input) {
    const context = ctx.sessions.get(input.sourceThreadId);
    if (!context) {
      return yield* new ProviderAdapterSessionNotFoundError({
        provider: PROVIDER,
        threadId: input.sourceThreadId,
      });
    }
    const sourceSessionId = context.resumeSessionId;
    if (!sourceSessionId) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "forkThread",
        detail: `Source thread '${input.sourceThreadId}' has no resume session id to fork from.`,
      });
    }

    const result = yield* Effect.tryPromise({
      try: () => forkSession(sourceSessionId),
      catch: (cause) =>
        toRequestError(
          PROVIDER,
          input.sourceThreadId,
          "forkSession",
          cause,
          CLAUDE_SESSION_ERROR_MATCHERS,
        ),
    });
    return {
      resumeCursor: { resume: result.sessionId },
    };
  });

export const stopSession = (ctx: ClaudeAdapterContext): ClaudeAdapterShape["stopSession"] =>
  Effect.fn("stopSession")(function* (threadId) {
    const context = yield* requireSession(ctx.sessions, threadId);
    yield* stopSessionInternal(ctx, context, {
      emitExitEvent: true,
    });
  });

export const listSessions =
  (ctx: ClaudeAdapterContext): ClaudeAdapterShape["listSessions"] =>
  () =>
    Effect.sync(() => Array.from(ctx.sessions.values(), ({ session }) => ({ ...session })));

export const hasSession =
  (ctx: ClaudeAdapterContext): ClaudeAdapterShape["hasSession"] =>
  (threadId) =>
    Effect.sync(() => {
      const context = ctx.sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

export const stopAll =
  (ctx: ClaudeAdapterContext): ClaudeAdapterShape["stopAll"] =>
  () =>
    Effect.forEach(
      ctx.sessions,
      ([, context]) =>
        stopSessionInternal(ctx, context, {
          emitExitEvent: true,
        }),
      { discard: true },
    );
