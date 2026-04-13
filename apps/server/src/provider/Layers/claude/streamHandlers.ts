/**
 * Stream event handlers for the Claude adapter.
 *
 * Each function takes a `ClaudeAdapterContext` (shared mutable state + event
 * infrastructure) and a `ClaudeSessionContext` (per-session state) as the first
 * two parameters. Pure helpers that only need session state omit the adapter
 * context parameter.
 *
 * @module claude/streamHandlers
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type ProviderRuntimeTurnStatus,
  ProviderItemId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  RuntimeTaskId,
} from "@forgetools/contracts";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Random } from "effect";

import { ProviderAdapterValidationError } from "../../Errors.ts";
import {
  asCanonicalTurnId,
  asRuntimeItemId,
  buildChildThreadAttribution,
  buildClaudeToolResultData,
  buildClaudeToolResultPatch,
  extractAssistantTextBlocks,
  extractContentBlockText,
  extractExitPlanModePlan,
  exitPlanCaptureKey,
  maxClaudeContextWindowFromModelUsage,
  nativeProviderRefs,
  normalizeClaudeTokenUsage,
  sdkNativeItemId,
  sdkNativeMethod,
  sdkParentToolUseId,
  sdkToolUseId,
  shouldKeepClaudeSubagentTrackingAfterToolResult,
  streamKindFromDeltaType,
  toolInputFingerprint,
  toolResultBlocksFromUserMessage,
  toolResultStreamKind,
  tryParseJsonRecord,
  turnStatusFromResult,
} from "./sdkMessageParsing.ts";
import { classifyToolItemType, summarizeToolRequest, titleForTool } from "./toolClassification.ts";
import { appendServerDebugRecord } from "../../../debug.ts";
import {
  PROVIDER,
  type AssistantTextBlockState,
  type ClaudeAdapterContext,
  type ClaudeSessionContext,
  type ToolInFlight,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Pure helpers (no adapter context needed)
// ---------------------------------------------------------------------------

export const snapshotThread = Effect.fn("snapshotThread")(function* (
  context: ClaudeSessionContext,
) {
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

export const ensureAssistantTextBlock = Effect.fn("ensureAssistantTextBlock")(function* (
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

export const createSyntheticAssistantTextBlock = Effect.fn("createSyntheticAssistantTextBlock")(
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

// ---------------------------------------------------------------------------
// Context-dependent helpers
// ---------------------------------------------------------------------------

export const updateResumeCursor = Effect.fn("updateResumeCursor")(function* (
  ctx: ClaudeAdapterContext,
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
    updatedAt: yield* ctx.nowIso,
  };
});

export const completeAssistantTextBlock = Effect.fn("completeAssistantTextBlock")(function* (
  ctx: ClaudeAdapterContext,
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
    const deltaStamp = yield* ctx.makeEventStamp();
    yield* ctx.offerRuntimeEvent({
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

  const stamp = yield* ctx.makeEventStamp();
  yield* ctx.offerRuntimeEvent({
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

export const backfillAssistantTextBlocksFromSnapshot = Effect.fn(
  "backfillAssistantTextBlocksFromSnapshot",
)(function* (ctx: ClaudeAdapterContext, context: ClaudeSessionContext, message: SDKMessage) {
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
      yield* completeAssistantTextBlock(ctx, context, entry.block, {
        rawMethod: "claude/assistant",
        rawPayload: message,
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Event emitters
// ---------------------------------------------------------------------------

export const emitTurnDiffUpdated = Effect.fn("emitTurnDiffUpdated")(function* (
  ctx: ClaudeAdapterContext,
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

  const stamp = yield* ctx.makeEventStamp();
  yield* ctx.offerRuntimeEvent({
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

export const recordClaudeTurnDiffFromToolResult = Effect.fn("recordClaudeTurnDiffFromToolResult")(
  function* (
    ctx: ClaudeAdapterContext,
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
      yield* emitTurnDiffUpdated(ctx, context, message);
      return;
    }

    context.turnState.agentDiffPatchesByToolUseId.set(toolResult.toolUseId, patch);
    yield* emitTurnDiffUpdated(ctx, context, message);
  },
);

export const logNativeSdkMessage = Effect.fn("logNativeSdkMessage")(function* (
  ctx: ClaudeAdapterContext,
  context: ClaudeSessionContext,
  message: SDKMessage,
) {
  if (!ctx.nativeEventLogger) {
    return;
  }

  const observedAt = new Date().toISOString();
  const itemId = sdkNativeItemId(message);

  yield* ctx.nativeEventLogger.write(
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
        ...(typeof message.session_id === "string" ? { providerThreadId: message.session_id } : {}),
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        ...(itemId ? { itemId: ProviderItemId.makeUnsafe(itemId) } : {}),
        payload: message,
      },
    },
    context.session.threadId,
  );
});

export const ensureThreadId = Effect.fn("ensureThreadId")(function* (
  ctx: ClaudeAdapterContext,
  context: ClaudeSessionContext,
  message: SDKMessage,
) {
  if (typeof message.session_id !== "string" || message.session_id.length === 0) {
    return;
  }
  const nextThreadId = message.session_id;
  context.resumeSessionId = message.session_id;
  yield* updateResumeCursor(ctx, context);

  if (context.lastThreadStartedId !== nextThreadId) {
    context.lastThreadStartedId = nextThreadId;
    const stamp = yield* ctx.makeEventStamp();
    yield* ctx.offerRuntimeEvent({
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

export const emitRuntimeError = Effect.fn("emitRuntimeError")(function* (
  ctx: ClaudeAdapterContext,
  context: ClaudeSessionContext,
  message: string,
  cause?: unknown,
) {
  if (cause !== undefined) {
    void cause;
  }
  const turnState = context.turnState;
  const stamp = yield* ctx.makeEventStamp();
  yield* ctx.offerRuntimeEvent({
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

export const emitRuntimeWarning = Effect.fn("emitRuntimeWarning")(function* (
  ctx: ClaudeAdapterContext,
  context: ClaudeSessionContext,
  message: string,
  detail?: unknown,
) {
  const turnState = context.turnState;
  const stamp = yield* ctx.makeEventStamp();
  yield* ctx.offerRuntimeEvent({
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

export const emitProposedPlanCompleted = Effect.fn("emitProposedPlanCompleted")(function* (
  ctx: ClaudeAdapterContext,
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

  const stamp = yield* ctx.makeEventStamp();
  yield* ctx.offerRuntimeEvent({
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

// ---------------------------------------------------------------------------
// Turn completion
// ---------------------------------------------------------------------------

export const completeTurn = Effect.fn("completeTurn")(function* (
  ctx: ClaudeAdapterContext,
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
      const usageStamp = yield* ctx.makeEventStamp();
      yield* ctx.offerRuntimeEvent({
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

    const stamp = yield* ctx.makeEventStamp();
    yield* ctx.offerRuntimeEvent({
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
    const toolStamp = yield* ctx.makeEventStamp();
    yield* ctx.offerRuntimeEvent({
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
    yield* completeAssistantTextBlock(ctx, context, block, {
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
    const usageStamp = yield* ctx.makeEventStamp();
    yield* ctx.offerRuntimeEvent({
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

  const stamp = yield* ctx.makeEventStamp();
  yield* ctx.offerRuntimeEvent({
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

  const updatedAt = yield* ctx.nowIso;
  context.turnState = undefined;
  context.session = {
    ...context.session,
    status: "ready",
    activeTurnId: undefined,
    updatedAt,
    ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
  };
  yield* updateResumeCursor(ctx, context);
});

// ---------------------------------------------------------------------------
// Per-message-type handlers
// ---------------------------------------------------------------------------

export const handleStreamEvent = Effect.fn("handleStreamEvent")(function* (
  ctx: ClaudeAdapterContext,
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
      const stamp = yield* ctx.makeEventStamp();
      const textDeltaAttribution = buildChildThreadAttribution(context, parentToolUseId);
      yield* ctx.offerRuntimeEvent({
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

      // SDK streaming quirk: at content_block_start, block.input is always `{}`.
      // The actual tool input fields (subagent_type, model, description, prompt) arrive
      // incrementally via input_json_delta events. We registered the agent tool in
      // activeSubagentTools at content_block_start with empty metadata — now we backfill
      // the real values as they stream in, before task_started fires and reads them
      // via buildChildThreadAttribution.
      //
      // When the SDK omits `model` from the tool input (common — Claude Code defaults
      // to the parent session's model internally), we fall back to currentApiModelId
      // so the UI can always show which model the subagent runs on.
      if (parsedInput && tool.itemType === "collab_agent_tool_call") {
        const existing = context.activeSubagentTools.get(tool.itemId);
        if (existing) {
          const agentType =
            existing.agentType ??
            (typeof parsedInput.subagent_type === "string" ? parsedInput.subagent_type : undefined);
          const agentModel =
            existing.agentModel ??
            (typeof parsedInput.model === "string"
              ? parsedInput.model
              : (context.currentApiModelId ?? undefined));
          const agentLabel =
            existing.label ??
            (typeof parsedInput.description === "string"
              ? parsedInput.description
              : typeof parsedInput.prompt === "string"
                ? parsedInput.prompt.slice(0, 120)
                : undefined);
          if (
            agentType !== existing.agentType ||
            agentModel !== existing.agentModel ||
            agentLabel !== existing.label
          ) {
            context.activeSubagentTools.set(tool.itemId, {
              ...existing,
              ...(agentType ? { agentType } : {}),
              ...(agentModel ? { agentModel } : {}),
              ...(agentLabel ? { label: agentLabel } : {}),
            });
            appendServerDebugRecord({
              topic: "claude-subagent",
              source: "handleStreamEvent/input_json_delta",
              label: "updated agent metadata from streamed input",
              details: {
                itemId: tool.itemId,
                agentType,
                agentModel,
                agentLabel,
              },
            });
          }
        }
      }

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
      const stamp = yield* ctx.makeEventStamp();
      yield* ctx.offerRuntimeEvent({
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
      appendServerDebugRecord({
        topic: "claude-subagent",
        source: "handleStreamEvent/content_block_start",
        label: "registered agent tool from stream event",
        details: { itemId, toolName, agentType, agentModel, agentLabel },
      });
    }

    const itemStartedAttribution = buildChildThreadAttribution(context, parentToolUseId);
    const stamp = yield* ctx.makeEventStamp();
    yield* ctx.offerRuntimeEvent({
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
      yield* completeAssistantTextBlock(ctx, context, assistantBlock, {
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

export const handleUserMessage = Effect.fn("handleUserMessage")(function* (
  ctx: ClaudeAdapterContext,
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

    const updatedStamp = yield* ctx.makeEventStamp();
    yield* ctx.offerRuntimeEvent({
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
      yield* recordClaudeTurnDiffFromToolResult(ctx, context, tool, toolResult, message);
    }

    const streamKind = toolResultStreamKind(tool.itemType);
    if (streamKind && toolResult.text.length > 0 && context.turnState) {
      const deltaStamp = yield* ctx.makeEventStamp();
      yield* ctx.offerRuntimeEvent({
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

    const completedStamp = yield* ctx.makeEventStamp();
    yield* ctx.offerRuntimeEvent({
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

export const handleAssistantMessage = Effect.fn("handleAssistantMessage")(function* (
  ctx: ClaudeAdapterContext,
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
    const startedAt = yield* ctx.nowIso;
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
    const turnStartedStamp = yield* ctx.makeEventStamp();
    yield* ctx.offerRuntimeEvent({
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
      if (toolUse.type !== "tool_use") {
        continue;
      }

      if (toolUse.name === "ExitPlanMode") {
        const planMarkdown = extractExitPlanModePlan(toolUse.input);
        if (planMarkdown) {
          yield* emitProposedPlanCompleted(ctx, context, {
            planMarkdown,
            toolUseId: typeof toolUse.id === "string" ? toolUse.id : undefined,
            rawSource: "claude.sdk.message",
            rawMethod: "claude/assistant",
            rawPayload: message,
          });
        }
        continue;
      }

      // The Claude Agent SDK can deliver tool_use blocks in two ways:
      //   1. Streamed: content_block_start (input={}) → input_json_delta… → content_block_stop
      //   2. Full message: type="assistant" with complete tool_use blocks and populated input
      //
      // The stream path registers the agent in activeSubagentTools at content_block_start
      // and backfills metadata during input_json_delta. This branch handles the full-message
      // path, where the complete input (subagent_type, model, description) is available
      // immediately. Both paths must populate activeSubagentTools so that subsequent
      // task_started / child events can resolve childThreadAttribution via
      // buildChildThreadAttribution.
      const toolName = typeof toolUse.name === "string" ? toolUse.name : undefined;
      const itemId = typeof toolUse.id === "string" ? toolUse.id : undefined;
      if (toolName && itemId && classifyToolItemType(toolName) === "collab_agent_tool_call") {
        const toolInput =
          typeof toolUse.input === "object" && toolUse.input !== null
            ? (toolUse.input as Record<string, unknown>)
            : {};
        const agentLabel =
          typeof toolInput.description === "string"
            ? toolInput.description
            : typeof toolInput.prompt === "string"
              ? toolInput.prompt.slice(0, 120)
              : undefined;
        const agentType =
          typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : undefined;
        const agentModel = typeof toolInput.model === "string" ? toolInput.model : undefined;
        if (!context.activeSubagentTools.has(itemId)) {
          const entry = {
            toolUseId: itemId,
            label: agentLabel,
            agentType,
            agentModel,
          };
          context.activeSubagentTools.set(itemId, entry);
          appendServerDebugRecord({
            topic: "claude-subagent",
            source: "handleAssistantMessage",
            label: "registered agent tool from full assistant message",
            details: { itemId, toolName, entry },
          });
        }
      }
    }
  }

  if (context.turnState) {
    context.turnState.items.push(message.message);
    yield* backfillAssistantTextBlocksFromSnapshot(ctx, context, message);
  }

  context.lastAssistantUuid = message.uuid;
  yield* updateResumeCursor(ctx, context);
});

export const handleResultMessage = Effect.fn("handleResultMessage")(function* (
  ctx: ClaudeAdapterContext,
  context: ClaudeSessionContext,
  message: SDKMessage,
) {
  if (message.type !== "result") {
    return;
  }

  const status = turnStatusFromResult(message);
  const errorMessage = message.subtype === "success" ? undefined : message.errors[0];

  if (status === "failed") {
    yield* emitRuntimeError(ctx, context, errorMessage ?? "Claude turn failed.");
  }

  yield* completeTurn(ctx, context, status, errorMessage, message);
});

export const handleSystemMessage = Effect.fn("handleSystemMessage")(function* (
  ctx: ClaudeAdapterContext,
  context: ClaudeSessionContext,
  message: SDKMessage,
) {
  if (message.type !== "system") {
    return;
  }

  const stamp = yield* ctx.makeEventStamp();
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
      yield* ctx.offerRuntimeEvent({
        ...base,
        type: "session.configured",
        payload: {
          config: message as Record<string, unknown>,
        },
      });
      return;
    case "status":
      yield* ctx.offerRuntimeEvent({
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
      yield* ctx.offerRuntimeEvent({
        ...base,
        type: "thread.state.changed",
        payload: {
          state: "compacted",
          detail: message,
        },
      });
      return;
    case "hook_started":
      yield* ctx.offerRuntimeEvent({
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
      yield* ctx.offerRuntimeEvent({
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
      yield* ctx.offerRuntimeEvent({
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
      const taskToolUseId = sdkToolUseId(message);
      const taskStartedAttribution = buildChildThreadAttribution(context, taskToolUseId);
      appendServerDebugRecord({
        topic: "claude-subagent",
        source: "handleSystemMessage/task_started",
        label: "building childThreadAttribution for task_started",
        details: {
          taskId: message.task_id,
          toolUseId: taskToolUseId,
          foundInActiveSubagentTools: taskToolUseId
            ? context.activeSubagentTools.has(taskToolUseId)
            : false,
          activeSubagentToolsKeys: Array.from(context.activeSubagentTools.keys()),
          attribution: taskStartedAttribution ?? null,
        },
      });
      yield* ctx.offerRuntimeEvent({
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
          const usageStamp = yield* ctx.makeEventStamp();
          yield* ctx.offerRuntimeEvent({
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
      yield* ctx.offerRuntimeEvent({
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
          const usageStamp = yield* ctx.makeEventStamp();
          yield* ctx.offerRuntimeEvent({
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
      const taskCompletedAttribution = buildChildThreadAttribution(context, sdkToolUseId(message));
      yield* ctx.offerRuntimeEvent({
        ...base,
        type: "task.completed",
        payload: {
          taskId: RuntimeTaskId.makeUnsafe(message.task_id),
          status: message.status,
          ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
          ...(message.summary ? { summary: message.summary } : {}),
          ...(message.usage ? { usage: message.usage } : {}),
          ...(taskCompletedAttribution ? { childThreadAttribution: taskCompletedAttribution } : {}),
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
        yield* completeAssistantTextBlock(ctx, context, syntheticBlock.block, {
          force: true,
          rawMethod: "claude/system/local_command_output",
          rawPayload: message,
        });
      }
      return;
    }
    case "files_persisted":
      yield* ctx.offerRuntimeEvent({
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
        ctx,
        context,
        `Unhandled Claude system message subtype '${message.subtype}'.`,
        message,
      );
      return;
  }
});

export const handleSdkTelemetryMessage = Effect.fn("handleSdkTelemetryMessage")(function* (
  ctx: ClaudeAdapterContext,
  context: ClaudeSessionContext,
  message: SDKMessage,
) {
  const stamp = yield* ctx.makeEventStamp();
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
    yield* ctx.offerRuntimeEvent({
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
    yield* ctx.offerRuntimeEvent({
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
    yield* ctx.offerRuntimeEvent({
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
    yield* ctx.offerRuntimeEvent({
      ...base,
      type: "account.rate-limits.updated",
      payload: {
        rateLimits: message,
      },
    });
    return;
  }
});

// ---------------------------------------------------------------------------
// Top-level SDK message dispatcher
// ---------------------------------------------------------------------------

export const handleSdkMessage = Effect.fn("handleSdkMessage")(function* (
  ctx: ClaudeAdapterContext,
  context: ClaudeSessionContext,
  message: SDKMessage,
) {
  yield* logNativeSdkMessage(ctx, context, message);
  yield* ensureThreadId(ctx, context, message);

  switch (message.type) {
    case "stream_event":
      yield* handleStreamEvent(ctx, context, message);
      return;
    case "user":
      yield* handleUserMessage(ctx, context, message);
      return;
    case "assistant":
      yield* handleAssistantMessage(ctx, context, message);
      return;
    case "result":
      yield* handleResultMessage(ctx, context, message);
      return;
    case "system":
      yield* handleSystemMessage(ctx, context, message);
      return;
    case "tool_progress":
    case "tool_use_summary":
    case "auth_status":
    case "rate_limit_event":
      yield* handleSdkTelemetryMessage(ctx, context, message);
      return;
    default:
      yield* emitRuntimeWarning(
        ctx,
        context,
        `Unhandled Claude SDK message type '${message.type}'.`,
        message,
      );
      return;
  }
});
