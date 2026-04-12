/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import {
  type CanUseTool,
  forkSession,
  query,
  type Options as ClaudeQueryOptions,
  type PermissionResult,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  ClaudeCodeEffort,
  EventId,
  type ProviderApprovalDecision,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeTaskId,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type UserInputQuestion,
} from "@forgetools/contracts";
import { resolveApiModelId, resolveEffort } from "@forgetools/shared/model";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Queue,
  Random,
  Ref,
  Stream,
} from "effect";

import { ServerConfig } from "../../config.ts";
import {
  getPendingMcpServer,
  type PendingMcpServerConfig,
  registerPendingMcpServer,
} from "../pendingMcpServers.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { getClaudeModelCapabilities } from "./ClaudeProvider.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { ClaudeAdapter, type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { CLAUDE_SESSION_ERROR_MATCHERS, toMessage, toRequestError } from "../adapterUtils.ts";
import { makeClaudeOAuthTokenResolver } from "../claudeOAuthCredential.ts";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

// --- Extracted claude/ modules ---
import {
  PROVIDER,
  type ClaudeAdapterLiveOptions,
  type ClaudeQueryRuntime,
  type ClaudeSessionContext,
  type ClaudeTurnState,
  type ActiveSubagentTool,
  type AssistantTextBlockState,
  type PendingApproval,
  type PendingUserInput,
  type ToolInFlight,
  type PromptQueueItem,
} from "./claude/types.ts";
import {
  asCanonicalTurnId,
  asRuntimeItemId,
  asRuntimeRequestId,
  buildChildThreadAttribution,
  buildClaudeToolResultData,
  buildClaudeToolResultPatch,
  extractAssistantTextBlocks,
  extractContentBlockText,
  extractExitPlanModePlan,
  exitPlanCaptureKey,
  getEffectiveClaudeCodeEffort,
  interruptionMessageFromClaudeCause,
  isClaudeInterruptedCause,
  maxClaudeContextWindowFromModelUsage,
  messageFromClaudeStreamCause,
  nativeProviderRefs,
  normalizeClaudeTokenUsage,
  readClaudeResumeState,
  sdkNativeItemId,
  sdkNativeMethod,
  sdkParentToolUseId,
  sdkToolUseId,
  shouldKeepClaudeSubagentTrackingAfterToolResult,
  streamKindFromDeltaType,
  toError,
  toolInputFingerprint,
  toolResultBlocksFromUserMessage,
  toolResultStreamKind,
  tryParseJsonRecord,
  turnStatusFromResult,
} from "./claude/sdkMessageParsing.ts";
import {
  classifyRequestType,
  classifyToolItemType,
  summarizeToolRequest,
  titleForTool,
} from "./claude/toolClassification.ts";
import { buildUserMessageEffect, CLAUDE_SETTING_SOURCES } from "./claude/messageBuilding.ts";

// Re-export for external consumers
export type { ClaudeAdapterLiveOptions } from "./claude/types.ts";

const makeClaudeAdapter = Effect.fn("makeClaudeAdapter")(function* (
  options?: ClaudeAdapterLiveOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const oauthResolver = yield* makeClaudeOAuthTokenResolver;
  const serverConfig = yield* ServerConfig;
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);

  const createQuery =
    options?.createQuery ??
    ((input: {
      readonly prompt: AsyncIterable<SDKUserMessage>;
      readonly options: ClaudeQueryOptions;
    }) => query({ prompt: input.prompt, options: input.options }) as ClaudeQueryRuntime);

  const sessions = new Map<ThreadId, ClaudeSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const serverSettingsService = yield* ServerSettingsService;
  const registerMcpServer = (threadId: string, mcpConfig: PendingMcpServerConfig) => {
    registerPendingMcpServer(threadId, mcpConfig);
  };

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const emitTurnDiffUpdated = Effect.fn("emitTurnDiffUpdated")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (!context.turnState) {
      return;
    }

    const unifiedDiff = Array.from(context.turnState.agentDiffPatchesByToolUseId.values())
      .map((patch) => patch.trim())
      .filter((patch) => patch.length > 0)
      .join("\n\n");

    if (
      context.turnState.lastEmittedUnifiedDiff === unifiedDiff &&
      context.turnState.agentDiffCoverage === "complete"
    ) {
      return;
    }

    context.turnState.lastEmittedUnifiedDiff = unifiedDiff;

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.diff.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: context.turnState.turnId,
      payload: {
        unifiedDiff,
        source: "derived_tool_results",
        coverage: context.turnState.agentDiffCoverage,
      },
      raw: {
        source: "claude.sdk.message",
        method: "claude/user",
        payload: message,
      },
    });
  });

  const recordClaudeTurnDiffFromToolResult = Effect.fn("recordClaudeTurnDiffFromToolResult")(
    function* (
      context: ClaudeSessionContext,
      tool: ToolInFlight,
      toolResult: {
        readonly toolUseId: string;
        readonly sdkToolUseResult: unknown;
      },
      message: SDKMessage,
    ) {
      if (!context.turnState || tool.itemType !== "file_change") {
        return;
      }

      const patch = buildClaudeToolResultPatch({
        sdkToolUseResult: toolResult.sdkToolUseResult,
        ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
      });

      if (patch === null) {
        context.turnState.agentDiffCoverage = "partial";
        yield* emitTurnDiffUpdated(context, message);
        return;
      }

      context.turnState.agentDiffPatchesByToolUseId.set(toolResult.toolUseId, patch);
      yield* emitTurnDiffUpdated(context, message);
    },
  );

  const logNativeSdkMessage = Effect.fn("logNativeSdkMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (!nativeEventLogger) {
      return;
    }

    const observedAt = new Date().toISOString();
    const itemId = sdkNativeItemId(message);

    yield* nativeEventLogger.write(
      {
        observedAt,
        event: {
          id:
            "uuid" in message && typeof message.uuid === "string"
              ? message.uuid
              : crypto.randomUUID(),
          kind: "notification",
          provider: PROVIDER,
          createdAt: observedAt,
          method: sdkNativeMethod(message),
          ...(typeof message.session_id === "string"
            ? { providerThreadId: message.session_id }
            : {}),
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          ...(itemId ? { itemId: ProviderItemId.makeUnsafe(itemId) } : {}),
          payload: message,
        },
      },
      context.session.threadId,
    );
  });

  const snapshotThread = Effect.fn("snapshotThread")(function* (context: ClaudeSessionContext) {
    const threadId = context.session.threadId;
    if (!threadId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "readThread",
        issue: "Session thread id is not initialized yet.",
      });
    }
    return {
      threadId,
      turns: context.turns.map((turn) => ({
        id: turn.id,
        items: [...turn.items],
      })),
    };
  });

  const updateResumeCursor = Effect.fn("updateResumeCursor")(function* (
    context: ClaudeSessionContext,
  ) {
    const threadId = context.session.threadId;
    if (!threadId) return;

    const resumeCursor = {
      threadId,
      ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
      ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
      turnCount: context.turns.length,
    };

    context.session = {
      ...context.session,
      resumeCursor,
      updatedAt: yield* nowIso,
    };
  });

  const ensureAssistantTextBlock = Effect.fn("ensureAssistantTextBlock")(function* (
    context: ClaudeSessionContext,
    blockIndex: number,
    options?: {
      readonly fallbackText?: string;
      readonly streamClosed?: boolean;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState) {
      return undefined;
    }

    const existing = turnState.assistantTextBlocks.get(blockIndex);
    if (existing && !existing.completionEmitted) {
      if (existing.fallbackText.length === 0 && options?.fallbackText) {
        existing.fallbackText = options.fallbackText;
      }
      if (options?.streamClosed) {
        existing.streamClosed = true;
      }
      return { blockIndex, block: existing };
    }

    const block: AssistantTextBlockState = {
      itemId: yield* Random.nextUUIDv4,
      blockIndex,
      emittedTextDelta: false,
      fallbackText: options?.fallbackText ?? "",
      streamClosed: options?.streamClosed ?? false,
      completionEmitted: false,
    };
    turnState.assistantTextBlocks.set(blockIndex, block);
    turnState.assistantTextBlockOrder.push(block);
    return { blockIndex, block };
  });

  const createSyntheticAssistantTextBlock = Effect.fn("createSyntheticAssistantTextBlock")(
    function* (context: ClaudeSessionContext, fallbackText: string) {
      const turnState = context.turnState;
      if (!turnState) {
        return undefined;
      }

      const blockIndex = turnState.nextSyntheticAssistantBlockIndex;
      turnState.nextSyntheticAssistantBlockIndex -= 1;
      return yield* ensureAssistantTextBlock(context, blockIndex, {
        fallbackText,
        streamClosed: true,
      });
    },
  );

  const completeAssistantTextBlock = Effect.fn("completeAssistantTextBlock")(function* (
    context: ClaudeSessionContext,
    block: AssistantTextBlockState,
    options?: {
      readonly force?: boolean;
      readonly rawMethod?: string;
      readonly rawPayload?: unknown;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState || block.completionEmitted) {
      return;
    }

    if (!options?.force && !block.streamClosed) {
      return;
    }

    if (!block.emittedTextDelta && block.fallbackText.length > 0) {
      const deltaStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "content.delta",
        eventId: deltaStamp.eventId,
        provider: PROVIDER,
        createdAt: deltaStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(block.itemId),
        payload: {
          streamKind: "assistant_text",
          delta: block.fallbackText,
        },
        providerRefs: nativeProviderRefs(context),
        ...(options?.rawMethod || options?.rawPayload
          ? {
              raw: {
                source: "claude.sdk.message" as const,
                ...(options.rawMethod ? { method: options.rawMethod } : {}),
                payload: options?.rawPayload,
              },
            }
          : {}),
      });
    }

    block.completionEmitted = true;
    if (turnState.assistantTextBlocks.get(block.blockIndex) === block) {
      turnState.assistantTextBlocks.delete(block.blockIndex);
    }

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "item.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      itemId: asRuntimeItemId(block.itemId),
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Assistant message",
        ...(block.fallbackText.length > 0 ? { detail: block.fallbackText } : {}),
      },
      providerRefs: nativeProviderRefs(context),
      ...(options?.rawMethod || options?.rawPayload
        ? {
            raw: {
              source: "claude.sdk.message" as const,
              ...(options.rawMethod ? { method: options.rawMethod } : {}),
              payload: options?.rawPayload,
            },
          }
        : {}),
    });
  });

  const backfillAssistantTextBlocksFromSnapshot = Effect.fn(
    "backfillAssistantTextBlocksFromSnapshot",
  )(function* (context: ClaudeSessionContext, message: SDKMessage) {
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }

    const snapshotTextBlocks = extractAssistantTextBlocks(message);
    if (snapshotTextBlocks.length === 0) {
      return;
    }

    const orderedBlocks = turnState.assistantTextBlockOrder.map((block) => ({
      blockIndex: block.blockIndex,
      block,
    }));

    for (const [position, text] of snapshotTextBlocks.entries()) {
      const existingEntry = orderedBlocks[position];
      const entry =
        existingEntry ??
        (yield* createSyntheticAssistantTextBlock(context, text).pipe(
          Effect.map((created) => {
            if (!created) {
              return undefined;
            }
            orderedBlocks.push(created);
            return created;
          }),
        ));
      if (!entry) {
        continue;
      }

      if (entry.block.fallbackText.length === 0) {
        entry.block.fallbackText = text;
      }

      if (entry.block.streamClosed && !entry.block.completionEmitted) {
        yield* completeAssistantTextBlock(context, entry.block, {
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
      }
    }
  });

  const ensureThreadId = Effect.fn("ensureThreadId")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (typeof message.session_id !== "string" || message.session_id.length === 0) {
      return;
    }
    const nextThreadId = message.session_id;
    context.resumeSessionId = message.session_id;
    yield* updateResumeCursor(context);

    if (context.lastThreadStartedId !== nextThreadId) {
      context.lastThreadStartedId = nextThreadId;
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "thread.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          providerThreadId: nextThreadId,
        },
        providerRefs: {},
        raw: {
          source: "claude.sdk.message",
          method: "claude/thread/started",
          payload: {
            session_id: message.session_id,
          },
        },
      });
    }
  });

  const emitRuntimeError = Effect.fn("emitRuntimeError")(function* (
    context: ClaudeSessionContext,
    message: string,
    cause?: unknown,
  ) {
    if (cause !== undefined) {
      void cause;
    }
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "runtime.error",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        class: "provider_error",
        ...(cause !== undefined ? { detail: cause } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitRuntimeWarning = Effect.fn("emitRuntimeWarning")(function* (
    context: ClaudeSessionContext,
    message: string,
    detail?: unknown,
  ) {
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "runtime.warning",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        ...(detail !== undefined ? { detail } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitProposedPlanCompleted = Effect.fn("emitProposedPlanCompleted")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly planMarkdown: string;
      readonly toolUseId?: string | undefined;
      readonly rawSource: "claude.sdk.message" | "claude.sdk.permission";
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) {
    const turnState = context.turnState;
    const planMarkdown = input.planMarkdown.trim();
    if (!turnState || planMarkdown.length === 0) {
      return;
    }

    const captureKey = exitPlanCaptureKey({
      toolUseId: input.toolUseId,
      planMarkdown,
    });
    if (turnState.capturedProposedPlanKeys.has(captureKey)) {
      return;
    }
    turnState.capturedProposedPlanKeys.add(captureKey);

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        planMarkdown,
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: input.toolUseId,
      }),
      raw: {
        source: input.rawSource,
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    });
  });

  const completeTurn = Effect.fn("completeTurn")(function* (
    context: ClaudeSessionContext,
    status: ProviderRuntimeTurnStatus,
    errorMessage?: string,
    result?: SDKResultMessage,
  ) {
    const resultUsage =
      result?.usage && typeof result.usage === "object" ? { ...result.usage } : undefined;
    const resultContextWindow = maxClaudeContextWindowFromModelUsage(result?.modelUsage);
    if (resultContextWindow !== undefined) {
      context.lastKnownContextWindow = resultContextWindow;
    }

    // The SDK result.usage contains *accumulated* totals across all API calls
    // (input_tokens, cache_read_input_tokens, etc. summed over every request).
    // This does NOT represent the current context window size.
    // Instead, use the last known context-window-accurate usage from task_progress
    // events and treat the accumulated total as totalProcessedTokens.
    const accumulatedSnapshot = normalizeClaudeTokenUsage(
      resultUsage,
      resultContextWindow ?? context.lastKnownContextWindow,
    );
    const lastGoodUsage = context.lastKnownTokenUsage;
    const maxTokens = resultContextWindow ?? context.lastKnownContextWindow;
    const usageSnapshot: ThreadTokenUsageSnapshot | undefined = lastGoodUsage
      ? {
          ...lastGoodUsage,
          ...(typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
            ? { maxTokens }
            : {}),
          ...(accumulatedSnapshot && accumulatedSnapshot.usedTokens > lastGoodUsage.usedTokens
            ? { totalProcessedTokens: accumulatedSnapshot.usedTokens }
            : {}),
        }
      : accumulatedSnapshot;

    const turnState = context.turnState;
    if (!turnState) {
      if (usageSnapshot) {
        const usageStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "thread.token-usage.updated",
          eventId: usageStamp.eventId,
          provider: PROVIDER,
          createdAt: usageStamp.createdAt,
          threadId: context.session.threadId,
          payload: {
            usage: usageSnapshot,
          },
          providerRefs: {},
        });
      }

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          state: status,
          ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
          ...(result?.usage ? { usage: result.usage } : {}),
          ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
          ...(typeof result?.total_cost_usd === "number"
            ? { totalCostUsd: result.total_cost_usd }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
        providerRefs: {},
      });
      return;
    }

    for (const [index, tool] of context.inFlightTools.entries()) {
      const toolStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: toolStamp.eventId,
        provider: PROVIDER,
        createdAt: toolStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: status === "completed" ? "completed" : "failed",
          title: tool.title,
          toolName: tool.toolName,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: {
            toolName: tool.toolName,
            input: tool.input,
          },
        },
        providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/result",
          payload: result ?? { status },
        },
      });
      if (tool.itemType === "collab_agent_tool_call") {
        context.activeSubagentTools.delete(tool.itemId);
      }
      context.inFlightTools.delete(index);
    }
    // Clear any remaining stale entries (e.g. from interrupted content blocks)
    context.inFlightTools.clear();
    context.activeSubagentTools.clear();

    for (const block of turnState.assistantTextBlockOrder) {
      yield* completeAssistantTextBlock(context, block, {
        force: true,
        rawMethod: "claude/result",
        rawPayload: result ?? { status },
      });
    }

    context.turns.push({
      id: turnState.turnId,
      items: [...turnState.items],
    });

    if (usageSnapshot) {
      const usageStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "thread.token-usage.updated",
        eventId: usageStamp.eventId,
        provider: PROVIDER,
        createdAt: usageStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: {
          usage: usageSnapshot,
        },
        providerRefs: nativeProviderRefs(context),
      });
    }

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        state: status,
        ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
        ...(result?.usage ? { usage: result.usage } : {}),
        ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
        ...(typeof result?.total_cost_usd === "number"
          ? { totalCostUsd: result.total_cost_usd }
          : {}),
        ...(errorMessage ? { errorMessage } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });

    const updatedAt = yield* nowIso;
    context.turnState = undefined;
    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt,
      ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
    };
    yield* updateResumeCursor(context);
  });

  const handleStreamEvent = Effect.fn("handleStreamEvent")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "stream_event") {
      return;
    }

    const { event } = message;
    const parentToolUseId = sdkParentToolUseId(message);

    if (event.type === "content_block_delta") {
      if (
        (event.delta.type === "text_delta" || event.delta.type === "thinking_delta") &&
        context.turnState
      ) {
        const deltaText =
          event.delta.type === "text_delta"
            ? event.delta.text
            : typeof event.delta.thinking === "string"
              ? event.delta.thinking
              : "";
        if (deltaText.length === 0) {
          return;
        }
        const streamKind = streamKindFromDeltaType(event.delta.type);
        const assistantBlockEntry =
          event.delta.type === "text_delta"
            ? yield* ensureAssistantTextBlock(context, event.index)
            : context.turnState.assistantTextBlocks.get(event.index)
              ? {
                  blockIndex: event.index,
                  block: context.turnState.assistantTextBlocks.get(
                    event.index,
                  ) as AssistantTextBlockState,
                }
              : undefined;
        if (assistantBlockEntry?.block && event.delta.type === "text_delta") {
          assistantBlockEntry.block.emittedTextDelta = true;
        }
        const stamp = yield* makeEventStamp();
        const textDeltaAttribution = buildChildThreadAttribution(context, parentToolUseId);
        yield* offerRuntimeEvent({
          type: "content.delta",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          ...(assistantBlockEntry?.block
            ? { itemId: asRuntimeItemId(assistantBlockEntry.block.itemId) }
            : {}),
          payload: {
            streamKind,
            delta: deltaText,
            ...(textDeltaAttribution ? { childThreadAttribution: textDeltaAttribution } : {}),
          },
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta",
            payload: message,
          },
        });
        return;
      }

      if (event.delta.type === "input_json_delta") {
        const tool = context.inFlightTools.get(event.index);
        if (!tool || typeof event.delta.partial_json !== "string") {
          return;
        }

        const partialInputJson = tool.partialInputJson + event.delta.partial_json;
        const parsedInput = tryParseJsonRecord(partialInputJson);
        const detail = parsedInput ? summarizeToolRequest(tool.toolName, parsedInput) : tool.detail;
        let nextTool: ToolInFlight = {
          ...tool,
          partialInputJson,
          ...(parsedInput ? { input: parsedInput } : {}),
          ...(detail ? { detail } : {}),
        };

        const nextFingerprint =
          parsedInput && Object.keys(parsedInput).length > 0
            ? toolInputFingerprint(parsedInput)
            : undefined;
        context.inFlightTools.set(event.index, nextTool);

        if (
          !parsedInput ||
          !nextFingerprint ||
          tool.lastEmittedInputFingerprint === nextFingerprint
        ) {
          return;
        }

        nextTool = {
          ...nextTool,
          lastEmittedInputFingerprint: nextFingerprint,
        };
        context.inFlightTools.set(event.index, nextTool);

        const inputDeltaAttribution = buildChildThreadAttribution(context, parentToolUseId);
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          itemId: asRuntimeItemId(nextTool.itemId),
          payload: {
            itemType: nextTool.itemType,
            status: "inProgress",
            title: nextTool.title,
            toolName: nextTool.toolName,
            ...(nextTool.detail ? { detail: nextTool.detail } : {}),
            data: {
              toolName: nextTool.toolName,
              input: nextTool.input,
            },
            ...(inputDeltaAttribution ? { childThreadAttribution: inputDeltaAttribution } : {}),
          },
          providerRefs: nativeProviderRefs(context, { providerItemId: nextTool.itemId }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta/input_json_delta",
            payload: message,
          },
        });
      }
      return;
    }

    if (event.type === "content_block_start") {
      const { index, content_block: block } = event;
      if (block.type === "text") {
        yield* ensureAssistantTextBlock(context, index, {
          fallbackText: extractContentBlockText(block),
        });
        return;
      }
      if (
        block.type !== "tool_use" &&
        block.type !== "server_tool_use" &&
        block.type !== "mcp_tool_use"
      ) {
        return;
      }

      const toolName = block.name;
      const itemType = classifyToolItemType(toolName);
      const toolInput =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      const itemId = block.id;
      const detail = summarizeToolRequest(toolName, toolInput);
      const inputFingerprint =
        Object.keys(toolInput).length > 0 ? toolInputFingerprint(toolInput) : undefined;

      const tool: ToolInFlight = {
        itemId,
        itemType,
        toolName,
        title: titleForTool(itemType),
        detail,
        input: toolInput,
        partialInputJson: "",
        ...(inputFingerprint ? { lastEmittedInputFingerprint: inputFingerprint } : {}),
      };
      context.inFlightTools.set(index, tool);

      // Track Agent/Task tool calls so children can reference them via parent_tool_use_id
      if (itemType === "collab_agent_tool_call") {
        const agentLabel =
          typeof toolInput.description === "string"
            ? toolInput.description
            : typeof toolInput.prompt === "string"
              ? toolInput.prompt.slice(0, 120)
              : undefined;
        const agentType =
          typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : undefined;
        const agentModel = typeof toolInput.model === "string" ? toolInput.model : undefined;
        context.activeSubagentTools.set(itemId, {
          toolUseId: itemId,
          label: agentLabel,
          agentType,
          agentModel,
        });
      }

      const itemStartedAttribution = buildChildThreadAttribution(context, parentToolUseId);
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: "inProgress",
          title: tool.title,
          toolName: tool.toolName,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: {
            toolName: tool.toolName,
            input: toolInput,
          },
          ...(itemStartedAttribution ? { childThreadAttribution: itemStartedAttribution } : {}),
        },
        providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/stream_event/content_block_start",
          payload: message,
        },
      });
      return;
    }

    if (event.type === "content_block_stop") {
      const { index } = event;
      const assistantBlock = context.turnState?.assistantTextBlocks.get(index);
      if (assistantBlock) {
        assistantBlock.streamClosed = true;
        yield* completeAssistantTextBlock(context, assistantBlock, {
          rawMethod: "claude/stream_event/content_block_stop",
          rawPayload: message,
        });
        return;
      }
      const tool = context.inFlightTools.get(index);
      if (!tool) {
        return;
      }
    }
  });

  const handleUserMessage = Effect.fn("handleUserMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "user") {
      return;
    }

    if (context.turnState) {
      context.turnState.items.push(message.message);
    }

    const userParentToolUseId = sdkParentToolUseId(message);

    for (const toolResult of toolResultBlocksFromUserMessage(message)) {
      const toolEntry = Array.from(context.inFlightTools.entries()).find(
        ([, tool]) => tool.itemId === toolResult.toolUseId,
      );
      if (!toolEntry) {
        continue;
      }

      const [index, tool] = toolEntry;
      const itemStatus = toolResult.isError ? "failed" : "completed";
      const toolData = buildClaudeToolResultData({
        tool,
        toolResultBlock: toolResult.block,
        sdkToolUseResult: toolResult.sdkToolUseResult,
        ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
      });

      const userToolAttribution = buildChildThreadAttribution(context, userParentToolUseId);

      const updatedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.updated",
        eventId: updatedStamp.eventId,
        provider: PROVIDER,
        createdAt: updatedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: toolResult.isError ? "failed" : "inProgress",
          title: tool.title,
          toolName: tool.toolName,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: toolData,
          ...(userToolAttribution ? { childThreadAttribution: userToolAttribution } : {}),
        },
        providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: message,
        },
      });

      if (!toolResult.isError) {
        yield* recordClaudeTurnDiffFromToolResult(context, tool, toolResult, message);
      }

      const streamKind = toolResultStreamKind(tool.itemType);
      if (streamKind && toolResult.text.length > 0 && context.turnState) {
        const deltaStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "content.delta",
          eventId: deltaStamp.eventId,
          provider: PROVIDER,
          createdAt: deltaStamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          itemId: asRuntimeItemId(tool.itemId),
          payload: {
            streamKind,
            delta: toolResult.text,
            ...(userToolAttribution ? { childThreadAttribution: userToolAttribution } : {}),
          },
          providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/user",
            payload: message,
          },
        });
      }

      const completedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: completedStamp.eventId,
        provider: PROVIDER,
        createdAt: completedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: itemStatus,
          title: tool.title,
          toolName: tool.toolName,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: toolData,
          ...(userToolAttribution ? { childThreadAttribution: userToolAttribution } : {}),
        },
        providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: message,
        },
      });

      if (tool.itemType === "collab_agent_tool_call") {
        const keepTracking = shouldKeepClaudeSubagentTrackingAfterToolResult({
          tool,
          sdkToolUseResult: toolData.toolUseResult,
        });
        if (!keepTracking) {
          context.activeSubagentTools.delete(tool.itemId);
        }
      }

      context.inFlightTools.delete(index);
    }
  });

  const handleAssistantMessage = Effect.fn("handleAssistantMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "assistant") {
      return;
    }

    // Auto-start a synthetic turn for assistant messages that arrive without
    // an active turn (e.g., background agent/subagent responses between user prompts).
    if (!context.turnState) {
      const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
      const startedAt = yield* nowIso;
      context.turnState = {
        turnId,
        startedAt,
        items: [],
        assistantTextBlocks: new Map(),
        assistantTextBlockOrder: [],
        capturedProposedPlanKeys: new Set(),
        agentDiffPatchesByToolUseId: new Map(),
        agentDiffCoverage: "complete",
        lastEmittedUnifiedDiff: null,
        nextSyntheticAssistantBlockIndex: -1,
      };
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: startedAt,
      };
      const turnStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.started",
        eventId: turnStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: turnStartedStamp.createdAt,
        threadId: context.session.threadId,
        turnId,
        payload: {},
        providerRefs: {
          ...nativeProviderRefs(context),
          providerTurnId: turnId,
        },
        raw: {
          source: "claude.sdk.message",
          method: "claude/synthetic-turn-start",
          payload: {},
        },
      });
    }

    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const toolUse = block as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          input?: unknown;
        };
        if (toolUse.type !== "tool_use" || toolUse.name !== "ExitPlanMode") {
          continue;
        }
        const planMarkdown = extractExitPlanModePlan(toolUse.input);
        if (!planMarkdown) {
          continue;
        }
        yield* emitProposedPlanCompleted(context, {
          planMarkdown,
          toolUseId: typeof toolUse.id === "string" ? toolUse.id : undefined,
          rawSource: "claude.sdk.message",
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
      }
    }

    if (context.turnState) {
      context.turnState.items.push(message.message);
      yield* backfillAssistantTextBlocksFromSnapshot(context, message);
    }

    context.lastAssistantUuid = message.uuid;
    yield* updateResumeCursor(context);
  });

  const handleResultMessage = Effect.fn("handleResultMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "result") {
      return;
    }

    const status = turnStatusFromResult(message);
    const errorMessage = message.subtype === "success" ? undefined : message.errors[0];

    if (status === "failed") {
      yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
    }

    yield* completeTurn(context, status, errorMessage, message);
  });

  const handleSystemMessage = Effect.fn("handleSystemMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "system") {
      return;
    }

    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: `${message.type}:${message.subtype}`,
        payload: message,
      },
    };

    if ((message as { subtype?: string }).subtype === "task_updated") {
      // Claude Code 2.1.101 emits `task_updated` terminal patches ahead of the richer
      // `task_notification` payload that carries tool_use_id, summary, output_file, and usage.
      // The direct SDK probe in `/tmp/claude-sdk-probe.mjs` showed background Bash and Agent
      // completions both following this sequence:
      //   task_updated({ patch: { status, end_time } }) -> task_notification(...)
      //
      // We intentionally do not treat `task_updated` as a terminal fallback. The same raw SDK
      // probes also showed nested subagent bash work receiving terminal-looking `task_updated`
      // patches like `status: "killed"` that are implementation detail, not the parent-facing
      // completion signal we want to render. Trust `task_notification` for visible completion;
      // ignore this lower-fidelity patch so it cannot surface as a bogus warning or duplicate
      // terminal task event.
      return;
    }

    switch (message.subtype) {
      case "init":
        yield* offerRuntimeEvent({
          ...base,
          type: "session.configured",
          payload: {
            config: message as Record<string, unknown>,
          },
        });
        return;
      case "status":
        yield* offerRuntimeEvent({
          ...base,
          type: "session.state.changed",
          payload: {
            state: message.status === "compacting" ? "waiting" : "running",
            reason: `status:${message.status ?? "active"}`,
            detail: message,
          },
        });
        return;
      case "compact_boundary":
        yield* offerRuntimeEvent({
          ...base,
          type: "thread.state.changed",
          payload: {
            state: "compacted",
            detail: message,
          },
        });
        return;
      case "hook_started":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.started",
          payload: {
            hookId: message.hook_id,
            hookName: message.hook_name,
            hookEvent: message.hook_event,
          },
        });
        return;
      case "hook_progress":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.progress",
          payload: {
            hookId: message.hook_id,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
          },
        });
        return;
      case "hook_response":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.completed",
          payload: {
            hookId: message.hook_id,
            outcome: message.outcome,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
            ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
          },
        });
        return;
      case "task_started": {
        const taskStartedAttribution = buildChildThreadAttribution(context, sdkToolUseId(message));
        yield* offerRuntimeEvent({
          ...base,
          type: "task.started",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(message.task_id),
            description: message.description,
            ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
            ...(message.task_type ? { taskType: message.task_type } : {}),
            ...(taskStartedAttribution ? { childThreadAttribution: taskStartedAttribution } : {}),
          },
        });
        return;
      }
      case "task_progress": {
        if (message.usage) {
          const normalizedUsage = normalizeClaudeTokenUsage(
            message.usage,
            context.lastKnownContextWindow,
          );
          if (normalizedUsage) {
            context.lastKnownTokenUsage = normalizedUsage;
            const usageStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              ...base,
              eventId: usageStamp.eventId,
              createdAt: usageStamp.createdAt,
              type: "thread.token-usage.updated",
              payload: {
                usage: normalizedUsage,
              },
            });
          }
        }
        const taskProgressAttribution = buildChildThreadAttribution(context, sdkToolUseId(message));
        yield* offerRuntimeEvent({
          ...base,
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(message.task_id),
            description: message.description,
            ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
            ...(taskProgressAttribution ? { childThreadAttribution: taskProgressAttribution } : {}),
          },
        });
        return;
      }
      case "task_notification": {
        if (message.usage) {
          const normalizedUsage = normalizeClaudeTokenUsage(
            message.usage,
            context.lastKnownContextWindow,
          );
          if (normalizedUsage) {
            context.lastKnownTokenUsage = normalizedUsage;
            const usageStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              ...base,
              eventId: usageStamp.eventId,
              createdAt: usageStamp.createdAt,
              type: "thread.token-usage.updated",
              payload: {
                usage: normalizedUsage,
              },
            });
          }
        }
        const taskCompletedAttribution = buildChildThreadAttribution(
          context,
          sdkToolUseId(message),
        );
        yield* offerRuntimeEvent({
          ...base,
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(message.task_id),
            status: message.status,
            ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(taskCompletedAttribution
              ? { childThreadAttribution: taskCompletedAttribution }
              : {}),
          },
        });
        if (message.tool_use_id) {
          context.activeSubagentTools.delete(message.tool_use_id);
        }
        return;
      }
      case "local_command_output": {
        const syntheticBlock = yield* createSyntheticAssistantTextBlock(context, message.content);
        if (syntheticBlock) {
          yield* completeAssistantTextBlock(context, syntheticBlock.block, {
            force: true,
            rawMethod: "claude/system/local_command_output",
            rawPayload: message,
          });
        }
        return;
      }
      case "files_persisted":
        yield* offerRuntimeEvent({
          ...base,
          type: "files.persisted",
          payload: {
            files: Array.isArray(message.files)
              ? message.files.map((file: { filename: string; file_id: string }) => ({
                  filename: file.filename,
                  fileId: file.file_id,
                }))
              : [],
            ...(Array.isArray(message.failed)
              ? {
                  failed: message.failed.map((entry: { filename: string; error: string }) => ({
                    filename: entry.filename,
                    error: entry.error,
                  })),
                }
              : {}),
          },
        });
        return;
      default:
        yield* emitRuntimeWarning(
          context,
          `Unhandled Claude system message subtype '${message.subtype}'.`,
          message,
        );
        return;
    }
  });

  const handleSdkTelemetryMessage = Effect.fn("handleSdkTelemetryMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: message.type,
        payload: message,
      },
    };

    if (message.type === "tool_progress") {
      yield* offerRuntimeEvent({
        ...base,
        type: "tool.progress",
        payload: {
          toolUseId: message.tool_use_id,
          toolName: message.tool_name,
          elapsedSeconds: message.elapsed_time_seconds,
          ...(message.task_id ? { summary: `task:${message.task_id}` } : {}),
        },
      });
      return;
    }

    if (message.type === "tool_use_summary") {
      yield* offerRuntimeEvent({
        ...base,
        type: "tool.summary",
        payload: {
          summary: message.summary,
          ...(message.preceding_tool_use_ids.length > 0
            ? { precedingToolUseIds: message.preceding_tool_use_ids }
            : {}),
        },
      });
      return;
    }

    if (message.type === "auth_status") {
      yield* offerRuntimeEvent({
        ...base,
        type: "auth.status",
        payload: {
          isAuthenticating: message.isAuthenticating,
          output: message.output,
          ...(message.error ? { error: message.error } : {}),
        },
      });
      return;
    }

    if (message.type === "rate_limit_event") {
      yield* offerRuntimeEvent({
        ...base,
        type: "account.rate-limits.updated",
        payload: {
          rateLimits: message,
        },
      });
      return;
    }
  });

  const handleSdkMessage = Effect.fn("handleSdkMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    yield* logNativeSdkMessage(context, message);
    yield* ensureThreadId(context, message);

    switch (message.type) {
      case "stream_event":
        yield* handleStreamEvent(context, message);
        return;
      case "user":
        yield* handleUserMessage(context, message);
        return;
      case "assistant":
        yield* handleAssistantMessage(context, message);
        return;
      case "result":
        yield* handleResultMessage(context, message);
        return;
      case "system":
        yield* handleSystemMessage(context, message);
        return;
      case "tool_progress":
      case "tool_use_summary":
      case "auth_status":
      case "rate_limit_event":
        yield* handleSdkTelemetryMessage(context, message);
        return;
      default:
        yield* emitRuntimeWarning(
          context,
          `Unhandled Claude SDK message type '${message.type}'.`,
          message,
        );
        return;
    }
  });

  const runSdkStream = (context: ClaudeSessionContext): Effect.Effect<void, Error> =>
    Stream.fromAsyncIterable(context.query, (cause) =>
      toError(cause, "Claude runtime stream failed."),
    ).pipe(
      Stream.takeWhile(() => !context.stopped),
      Stream.runForEach((message) => handleSdkMessage(context, message)),
    );

  const handleStreamExit = Effect.fn("handleStreamExit")(function* (
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
            context,
            "interrupted",
            interruptionMessageFromClaudeCause(exit.cause),
          );
        }
      } else {
        const message = messageFromClaudeStreamCause(exit.cause, "Claude runtime stream failed.");
        yield* emitRuntimeError(context, message, Cause.pretty(exit.cause));
        yield* completeTurn(context, "failed", message);
      }
    } else if (context.turnState) {
      yield* completeTurn(context, "interrupted", "Claude runtime stream ended.");
    }

    yield* stopSessionInternal(context, {
      emitExitEvent: true,
    });
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    context: ClaudeSessionContext,
    options?: { readonly emitExitEvent?: boolean },
  ) {
    if (context.stopped) return;

    context.stopped = true;

    for (const [requestId, pending] of context.pendingApprovals) {
      yield* Deferred.succeed(pending.decision, "cancel");
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
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
      yield* completeTurn(context, "interrupted", "Session stopped.");
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
      yield* emitRuntimeError(context, "Failed to close Claude runtime query.", cause);
    }

    const updatedAt = yield* nowIso;
    context.session = {
      ...context.session,
      status: "closed",
      activeTurnId: undefined,
      updatedAt,
    };

    if (options?.emitExitEvent !== false) {
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
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

    sessions.delete(context.session.threadId);
  });

  const requireSession = (
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

  const startSession: ClaudeAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const startedAt = yield* nowIso;
      const resumeState = readClaudeResumeState(input.resumeCursor);
      const threadId = input.threadId;
      const existingResumeSessionId = resumeState?.resume;
      const newSessionId =
        existingResumeSessionId === undefined ? yield* Random.nextUUIDv4 : undefined;
      const sessionId = existingResumeSessionId ?? newSessionId;

      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);
      const runPromise = Effect.runPromiseWith(services);

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
        const requestedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
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
        const resolvedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
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
            yield* emitProposedPlanCompleted(context, {
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

        const requestedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
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

        const resolvedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
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

      const claudeSettings = yield* serverSettingsService.getSettings.pipe(
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

      const oauthToken = yield* oauthResolver.getToken;

      const queryOptions: ClaudeQueryOptions = {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(apiModelId ? { model: apiModelId } : {}),
        pathToClaudeCodeExecutable: claudeBinaryPath,
        settingSources: [...CLAUDE_SETTING_SOURCES],
        ...(effectiveEffort ? { effort: effectiveEffort } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(permissionMode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
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
          createQuery({
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
      sessions.set(threadId, context);

      const sessionStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.started",
        eventId: sessionStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: sessionStartedStamp.createdAt,
        threadId,
        payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
        providerRefs: {},
      });

      const configuredStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
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

      const readyStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
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
        Effect.exit(runSdkStream(context)).pipe(
          Effect.flatMap((exit) => {
            if (context.stopped) {
              return Effect.void;
            }
            if (context.streamFiber === streamFiber) {
              context.streamFiber = undefined;
            }
            return handleStreamExit(context, exit);
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
    },
  );

  const sendTurn: ClaudeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    const modelSelection =
      input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;

    if (context.turnState) {
      // Auto-close a stale synthetic turn (from background agent responses
      // between user prompts) to prevent blocking the user's next turn.
      yield* completeTurn(context, "completed");
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
      startedAt: yield* nowIso,
      items: [],
      assistantTextBlocks: new Map(),
      assistantTextBlockOrder: [],
      capturedProposedPlanKeys: new Set(),
      agentDiffPatchesByToolUseId: new Map(),
      agentDiffCoverage: "complete",
      lastEmittedUnifiedDiff: null,
      nextSyntheticAssistantBlockIndex: -1,
    };

    const updatedAt = yield* nowIso;
    context.turnState = turnState;
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt,
    };

    const turnStartedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
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
      fileSystem,
      attachmentsDir: serverConfig.attachmentsDir,
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

  const interruptTurn: ClaudeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId, _turnId) {
      const context = yield* requireSession(threadId);
      yield* Effect.tryPromise({
        try: () => context.query.interrupt(),
        catch: (cause) =>
          toRequestError(
            PROVIDER,
            threadId,
            "turn/interrupt",
            cause,
            CLAUDE_SESSION_ERROR_MATCHERS,
          ),
      });
    },
  );

  const readThread: ClaudeAdapterShape["readThread"] = Effect.fn("readThread")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      return yield* snapshotThread(context);
    },
  );

  const rollbackThread: ClaudeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns) {
      const context = yield* requireSession(threadId);
      const nextLength = Math.max(0, context.turns.length - numTurns);
      context.turns.splice(nextLength);
      yield* updateResumeCursor(context);
      return yield* snapshotThread(context);
    },
  );

  const respondToRequest: ClaudeAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, requestId, decision) {
      const context = yield* requireSession(threadId);
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
    },
  );

  const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (threadId, requestId, answers) {
    const context = yield* requireSession(threadId);
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

  const forkThread: ClaudeAdapterShape["forkThread"] = Effect.fn("forkThread")(function* (input) {
    const context = sessions.get(input.sourceThreadId);
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

  const stopSession: ClaudeAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      yield* stopSessionInternal(context, {
        emitExitEvent: true,
      });
    },
  );

  const listSessions: ClaudeAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopAll: ClaudeAdapterShape["stopAll"] = () =>
    Effect.forEach(
      sessions,
      ([, context]) =>
        stopSessionInternal(context, {
          emitExitEvent: true,
        }),
      { discard: true },
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      sessions,
      ([, context]) =>
        stopSessionInternal(context, {
          emitExitEvent: false,
        }),
      { discard: true },
    ).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    forkThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    registerMcpServer,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } satisfies ClaudeAdapterShape;
});

export const ClaudeAdapterLive = Layer.effect(ClaudeAdapter, makeClaudeAdapter());

export function makeClaudeAdapterLive(options?: ClaudeAdapterLiveOptions) {
  return Layer.effect(ClaudeAdapter, makeClaudeAdapter(options));
}
