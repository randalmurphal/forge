/**
 * Maps raw Codex provider events into canonical ProviderRuntimeEvent arrays.
 *
 * The main `mapToRuntimeEvents` function dispatches to focused category mappers,
 * each of which handles a related group of event methods. Category mappers return
 * `undefined` when the event is not theirs, an empty array when matched but
 * nothing to emit, and a non-empty array of runtime events otherwise.
 *
 * @module codex/mapToRuntimeEvents
 */
import type {
  ProviderEvent,
  ProviderRuntimeEvent,
  ProviderUserInputAnswers,
} from "@forgetools/contracts";
import { ProviderApprovalDecision, type ThreadId } from "@forgetools/contracts";
import { Schema } from "effect";

import { asFiniteNumber, asRecord, asString } from "@forgetools/shared/narrowing";

import { logBackgroundDebug } from "../../adapterUtils.ts";
import {
  asRuntimeTaskId,
  codexEventBase,
  codexEventMessage,
  contentStreamKindFromMethod,
  extractProposedPlanMarkdown,
  isFatalCodexProcessStderrMessage,
  itemDetail,
  mapItemLifecycle,
  normalizeCodexTokenUsage,
  runtimeEventBase,
  toCanonicalItemType,
  toCanonicalUserInputAnswers,
  toRequestTypeFromKind,
  toRequestTypeFromMethod,
  toRequestTypeFromResolvedPayload,
  toThreadState,
  toTurnStatus,
  toUserInputQuestions,
} from "./eventHelpers.ts";

function normalizeMcpStartupStatus(
  value: unknown,
): "starting" | "ready" | "failed" | "cancelled" | undefined {
  switch (value) {
    case "starting":
    case "ready":
    case "failed":
    case "cancelled":
      return value;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Category mapper return type
// ---------------------------------------------------------------------------

type MappedEvents = ReadonlyArray<ProviderRuntimeEvent> | undefined;

// ---------------------------------------------------------------------------
// Error events
// ---------------------------------------------------------------------------

function mapErrorEvent(event: ProviderEvent, canonicalThreadId: ThreadId): MappedEvents {
  if (event.kind !== "error") {
    return undefined;
  }
  if (!event.message) {
    return [];
  }
  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "runtime.error",
      payload: {
        message: event.message,
        class: "provider_error",
        ...(event.payload !== undefined ? { detail: event.payload } : {}),
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Request events
// ---------------------------------------------------------------------------

function mapRequestEvent(event: ProviderEvent, canonicalThreadId: ThreadId): MappedEvents {
  if (event.kind === "request") {
    const payload = asRecord(event.payload);

    if (event.method === "item/tool/requestUserInput") {
      const questions = toUserInputQuestions(payload);
      if (!questions) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: {
            questions,
          },
        },
      ];
    }

    const detail =
      asString(payload?.command) ?? asString(payload?.reason) ?? asString(payload?.prompt);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType: toRequestTypeFromMethod(event.method),
          ...(detail ? { detail } : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const payload = asRecord(event.payload);
    const decision = Schema.decodeUnknownSync(ProviderApprovalDecision)(payload?.decision);
    const requestType =
      event.requestKind !== undefined
        ? toRequestTypeFromKind(event.requestKind)
        : toRequestTypeFromMethod(event.method);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(decision ? { decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "serverRequest/resolved") {
    const payload = asRecord(event.payload);
    const requestType =
      toRequestTypeFromResolvedPayload(payload) !== "unknown"
        ? toRequestTypeFromResolvedPayload(payload)
        : event.requestId && event.requestKind !== undefined
          ? toRequestTypeFromKind(event.requestKind)
          : "unknown";
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/tool/requestUserInput/answered") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: {
          answers: toCanonicalUserInputAnswers(
            asRecord(event.payload)?.answers as ProviderUserInputAnswers | undefined,
          ),
        },
      },
    ];
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Session events
// ---------------------------------------------------------------------------

function mapSessionEvent(event: ProviderEvent, canonicalThreadId: ThreadId): MappedEvents {
  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(event.payload !== undefined ? { resume: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
        },
      },
    ];
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Thread events
// ---------------------------------------------------------------------------

function mapThreadEvent(event: ProviderEvent, canonicalThreadId: ThreadId): MappedEvents {
  const payload = asRecord(event.payload);

  if (event.method === "thread/started") {
    const payloadThreadId = asString(asRecord(payload?.thread)?.id);
    const providerThreadId = payloadThreadId ?? asString(payload?.threadId);
    if (!providerThreadId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.started",
        payload: {
          providerThreadId,
        },
      },
    ];
  }

  if (
    event.method === "thread/status/changed" ||
    event.method === "thread/archived" ||
    event.method === "thread/unarchived" ||
    event.method === "thread/closed" ||
    event.method === "thread/compacted"
  ) {
    return [
      {
        type: "thread.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state:
            event.method === "thread/archived"
              ? "archived"
              : event.method === "thread/closed"
                ? "closed"
                : event.method === "thread/compacted"
                  ? "compacted"
                  : toThreadState(asRecord(payload?.thread)?.state ?? payload?.state),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/name/updated") {
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(asString(payload?.threadName) ? { name: asString(payload?.threadName) } : {}),
          ...(event.payload !== undefined ? { metadata: asRecord(event.payload) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/tokenUsage/updated") {
    const tokenUsage = asRecord(payload?.tokenUsage);
    const normalizedUsage = normalizeCodexTokenUsage(tokenUsage ?? event.payload);
    if (!normalizedUsage) {
      return [];
    }
    return [
      {
        type: "thread.token-usage.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          usage: normalizedUsage,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/started") {
    const realtimeSessionId = asString(payload?.realtimeSessionId);
    return [
      {
        type: "thread.realtime.started",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          realtimeSessionId,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/itemAdded") {
    return [
      {
        type: "thread.realtime.item-added",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          item: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/outputAudio/delta") {
    return [
      {
        type: "thread.realtime.audio.delta",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          audio: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/error") {
    const message = asString(payload?.message) ?? event.message ?? "Realtime error";
    return [
      {
        type: "thread.realtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/closed") {
    return [
      {
        type: "thread.realtime.closed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          reason: event.message,
        },
      },
    ];
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Turn events
// ---------------------------------------------------------------------------

function mapTurnEvent(event: ProviderEvent, canonicalThreadId: ThreadId): MappedEvents {
  const payload = asRecord(event.payload);
  const turn = asRecord(payload?.turn);

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId,
        type: "turn.started",
        payload: {
          ...(asString(turn?.model) ? { model: asString(turn?.model) } : {}),
          ...(asString(turn?.effort) ? { effort: asString(turn?.effort) } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/completed") {
    const errorMessage = asString(asRecord(turn?.error)?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: toTurnStatus(turn?.status),
          ...(asString(turn?.stopReason) ? { stopReason: asString(turn?.stopReason) } : {}),
          ...(turn?.usage !== undefined ? { usage: turn.usage } : {}),
          ...(asRecord(turn?.modelUsage) ? { modelUsage: asRecord(turn?.modelUsage) } : {}),
          ...(asFiniteNumber(turn?.totalCostUsd) !== undefined
            ? { totalCostUsd: asFiniteNumber(turn?.totalCostUsd) }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/aborted") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.aborted",
        payload: {
          reason: event.message ?? "Turn aborted",
        },
      },
    ];
  }

  if (event.method === "turn/plan/updated") {
    const steps = Array.isArray(payload?.plan) ? payload.plan : [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.plan.updated",
        payload: {
          ...(asString(payload?.explanation)
            ? { explanation: asString(payload?.explanation) }
            : {}),
          plan: steps
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => entry !== undefined)
            .map((entry) => ({
              step: asString(entry.step) ?? "step",
              status:
                entry.status === "completed" || entry.status === "inProgress"
                  ? entry.status
                  : "pending",
            })),
        },
      },
    ];
  }

  if (event.method === "turn/diff/updated") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.diff.updated",
        payload: {
          unifiedDiff:
            asString(payload?.unifiedDiff) ??
            asString(payload?.diff) ??
            asString(payload?.patch) ??
            "",
          source: "native_turn_diff",
          coverage: "complete",
        },
      },
    ];
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Item events
// ---------------------------------------------------------------------------

function mapItemEvent(event: ProviderEvent, canonicalThreadId: ThreadId): MappedEvents {
  const payload = asRecord(event.payload);

  if (event.method === "item/started") {
    const started = mapItemLifecycle(event, canonicalThreadId, "item.started");
    return started ? [started] : [];
  }

  if (event.method === "item/completed") {
    const payload = asRecord(event.payload);
    const item = asRecord(payload?.item);
    const source = item ?? payload;
    if (!source) {
      return [];
    }
    const itemType = source ? toCanonicalItemType(source.type ?? source.kind) : "unknown";
    if (itemType === "plan") {
      const detail = itemDetail(source, payload ?? {});
      if (!detail) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: detail,
          },
        },
      ];
    }
    const completed = mapItemLifecycle(event, canonicalThreadId, "item.completed");
    return completed ? [completed] : [];
  }

  if (event.method === "item/reasoning/summaryPartAdded") {
    const updated = mapItemLifecycle(event, canonicalThreadId, "item.updated");
    return updated ? [updated] : [];
  }

  if (event.method === "item/commandExecution/terminalInteraction") {
    const processId = asString(payload?.processId);
    const stdin = asString(payload?.stdin);
    if (!processId || stdin === undefined) {
      return [];
    }
    const childThreadAttribution = asRecord(payload?._childThreadAttribution);
    logBackgroundDebug("adapter", "terminalInteraction", {
      method: event.method,
      canonicalThreadId,
      turnId: event.turnId ?? null,
      itemId: asString(payload?.itemId) ?? null,
      processId,
      stdinLength: stdin.length,
      hasChildThreadAttribution: childThreadAttribution !== undefined,
    });
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "terminal.interaction",
        payload: {
          processId,
          stdin,
          ...(childThreadAttribution ? { childThreadAttribution } : {}),
        },
      },
    ];
  }

  if (event.method === "item/plan/delta") {
    const delta =
      event.textDelta ??
      asString(payload?.delta) ??
      asString(payload?.text) ??
      asString(asRecord(payload?.content)?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.proposed.delta",
        payload: {
          delta,
        },
      },
    ];
  }

  if (
    event.method === "item/agentMessage/delta" ||
    event.method === "item/commandExecution/outputDelta" ||
    event.method === "item/fileChange/outputDelta" ||
    event.method === "item/reasoning/summaryTextDelta" ||
    event.method === "item/reasoning/textDelta"
  ) {
    const delta =
      event.textDelta ??
      asString(payload?.delta) ??
      asString(payload?.text) ??
      asString(asRecord(payload?.content)?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    const childThreadAttribution = asRecord(payload?._childThreadAttribution);
    if (event.method === "item/commandExecution/outputDelta") {
      logBackgroundDebug("adapter", "commandOutputDelta", {
        method: event.method,
        canonicalThreadId,
        turnId: event.turnId ?? null,
        itemId: asString(payload?.itemId) ?? null,
        deltaLength: delta.length,
        hasChildThreadAttribution: childThreadAttribution !== undefined,
      });
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: contentStreamKindFromMethod(event.method),
          delta,
          ...(typeof payload?.contentIndex === "number"
            ? { contentIndex: payload.contentIndex }
            : {}),
          ...(typeof payload?.summaryIndex === "number"
            ? { summaryIndex: payload.summaryIndex }
            : {}),
          ...(childThreadAttribution ? { childThreadAttribution } : {}),
        },
      },
    ];
  }

  if (event.method === "item/mcpToolCall/progress") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "tool.progress",
        payload: {
          ...(asString(payload?.toolUseId) ? { toolUseId: asString(payload?.toolUseId) } : {}),
          ...(asString(payload?.toolName) ? { toolName: asString(payload?.toolName) } : {}),
          ...(asString(payload?.summary) ? { summary: asString(payload?.summary) } : {}),
          ...(asFiniteNumber(payload?.elapsedSeconds) !== undefined
            ? { elapsedSeconds: asFiniteNumber(payload?.elapsedSeconds) }
            : {}),
        },
      },
    ];
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Task events (codex/event/*)
// ---------------------------------------------------------------------------

function mapTaskEvent(event: ProviderEvent, canonicalThreadId: ThreadId): MappedEvents {
  const payload = asRecord(event.payload);

  if (event.method === "codex/event/task_started") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
    if (!taskId) {
      return [];
    }
    const childThreadAttribution = asRecord(payload?._childThreadAttribution);
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.started",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          ...(asString(msg?.collaboration_mode_kind)
            ? { taskType: asString(msg?.collaboration_mode_kind) }
            : {}),
          ...(childThreadAttribution ? { childThreadAttribution } : {}),
        },
      },
    ];
  }

  if (event.method === "codex/event/task_complete") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
    const proposedPlanMarkdown = extractProposedPlanMarkdown(asString(msg?.last_agent_message));
    if (!taskId) {
      if (!proposedPlanMarkdown) {
        return [];
      }
      return [
        {
          ...codexEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: proposedPlanMarkdown,
          },
        },
      ];
    }
    const childThreadAttribution = asRecord(payload?._childThreadAttribution);
    const events: ProviderRuntimeEvent[] = [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.completed",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          status: "completed",
          ...(asString(msg?.last_agent_message)
            ? { summary: asString(msg?.last_agent_message) }
            : {}),
          ...(childThreadAttribution ? { childThreadAttribution } : {}),
        },
      },
    ];
    if (proposedPlanMarkdown) {
      events.push({
        ...codexEventBase(event, canonicalThreadId),
        type: "turn.proposed.completed",
        payload: {
          planMarkdown: proposedPlanMarkdown,
        },
      });
    }
    return events;
  }

  if (event.method === "codex/event/agent_reasoning") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id);
    const description = asString(msg?.text);
    if (!taskId || !description) {
      return [];
    }
    const childThreadAttribution = asRecord(payload?._childThreadAttribution);
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.progress",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          description,
          ...(childThreadAttribution ? { childThreadAttribution } : {}),
        },
      },
    ];
  }

  if (event.method === "codex/event/reasoning_content_delta") {
    const msg = codexEventMessage(payload);
    const delta = asString(msg?.delta);
    if (!delta) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind:
            asFiniteNumber(msg?.summary_index) !== undefined
              ? "reasoning_summary_text"
              : "reasoning_text",
          delta,
          ...(asFiniteNumber(msg?.summary_index) !== undefined
            ? { summaryIndex: asFiniteNumber(msg?.summary_index) }
            : {}),
        },
      },
    ];
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Telemetry events
// ---------------------------------------------------------------------------

function mapTelemetryEvent(event: ProviderEvent, canonicalThreadId: ThreadId): MappedEvents {
  const payload = asRecord(event.payload);
  const hookRun = asRecord(payload?.run);

  if (event.method === "hook/started") {
    const hookId = asString(hookRun?.id);
    const hookEvent = asString(hookRun?.eventName);
    const hookName = asString(hookRun?.sourcePath) ?? asString(hookRun?.handlerType);
    if (!hookId || !hookEvent || !hookName) {
      return [];
    }
    return [
      {
        type: "hook.started",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          hookId,
          hookName,
          hookEvent,
        },
      },
    ];
  }

  if (event.method === "hook/completed") {
    const hookId = asString(hookRun?.id);
    if (!hookId) {
      return [];
    }
    const outcomeRaw = asString(hookRun?.status);
    const outcome = outcomeRaw === "error" || outcomeRaw === "cancelled" ? outcomeRaw : "success";
    const output = asString(hookRun?.statusMessage);
    return [
      {
        type: "hook.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          hookId,
          outcome,
          ...(output ? { output } : {}),
        },
      },
    ];
  }

  if (event.method === "item/autoApprovalReview/started") {
    return [
      {
        type: "tool.progress",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          toolName: "guardian-review",
          summary: "Safety review in progress",
        },
      },
    ];
  }

  if (event.method === "item/autoApprovalReview/completed") {
    return [
      {
        type: "tool.summary",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: "Safety review completed",
        },
      },
    ];
  }

  if (event.method === "model/rerouted") {
    return [
      {
        type: "model.rerouted",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          fromModel: asString(payload?.fromModel) ?? "unknown",
          toModel: asString(payload?.toModel) ?? "unknown",
          reason: asString(payload?.reason) ?? "unknown",
        },
      },
    ];
  }

  if (event.method === "deprecationNotice") {
    return [
      {
        type: "deprecation.notice",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asString(payload?.summary) ?? "Deprecation notice",
          ...(asString(payload?.details) ? { details: asString(payload?.details) } : {}),
        },
      },
    ];
  }

  if (event.method === "configWarning") {
    return [
      {
        type: "config.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asString(payload?.summary) ?? "Configuration warning",
          ...(asString(payload?.details) ? { details: asString(payload?.details) } : {}),
          ...(asString(payload?.path) ? { path: asString(payload?.path) } : {}),
          ...(payload?.range !== undefined ? { range: payload.range } : {}),
        },
      },
    ];
  }

  if (event.method === "account/updated") {
    return [
      {
        type: "account.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          account: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/rateLimits/updated") {
    return [
      {
        type: "account.rate-limits.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          rateLimits: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "mcpServer/oauthLogin/completed") {
    return [
      {
        type: "mcp.oauth.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          success: payload?.success === true,
          ...(asString(payload?.name) ? { name: asString(payload?.name) } : {}),
          ...(asString(payload?.error) ? { error: asString(payload?.error) } : {}),
        },
      },
    ];
  }

  if (event.method === "mcpServer/startupStatus/updated") {
    const payload = asRecord(event.payload);
    const name = asString(payload?.name);
    const status = normalizeMcpStartupStatus(payload?.status);
    const rawError = payload?.error;
    const error =
      rawError == null ? undefined : typeof rawError === "string" ? rawError : undefined;

    if (!name || !status || (rawError != null && error === undefined)) {
      return [
        {
          type: "runtime.warning",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {
            message: "Received invalid MCP startup status update",
            detail: event.payload,
          },
        },
      ];
    }

    return [
      {
        type: "mcp.status.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          name,
          status,
          ...(error ? { error } : {}),
        },
      },
    ];
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Infrastructure events (errors, stderr, sandbox, warnings)
// ---------------------------------------------------------------------------

function mapInfraEvent(event: ProviderEvent, canonicalThreadId: ThreadId): MappedEvents {
  const payload = asRecord(event.payload);

  if (event.method === "error") {
    const message =
      asString(asRecord(payload?.error)?.message) ?? event.message ?? "Provider runtime error";
    const willRetry = payload?.willRetry === true;
    return [
      {
        type: willRetry ? "runtime.warning" : "runtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
          ...(!willRetry ? { class: "provider_error" as const } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "process/stderr") {
    const message = event.message ?? "Codex process stderr";
    const isFatal = isFatalCodexProcessStderrMessage(message);
    return [
      isFatal
        ? {
            type: "runtime.error",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message,
              class: "provider_error" as const,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          }
        : {
            type: "runtime.warning",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          },
    ];
  }

  if (event.method === "windows/worldWritableWarning") {
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message ?? "Windows world-writable warning",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windowsSandbox/setupCompleted") {
    const payloadRecord = asRecord(event.payload);
    const success = payloadRecord?.success;
    const successMessage = event.message ?? "Windows sandbox setup completed";
    const failureMessage = event.message ?? "Windows sandbox setup failed";

    return [
      {
        type: "session.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state: success === false ? "error" : "ready",
          reason: success === false ? failureMessage : successMessage,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
      ...(success === false
        ? [
            {
              type: "runtime.warning" as const,
              ...runtimeEventBase(event, canonicalThreadId),
              payload: {
                message: failureMessage,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            },
          ]
        : []),
    ];
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  return (
    mapErrorEvent(event, canonicalThreadId) ??
    mapRequestEvent(event, canonicalThreadId) ??
    mapSessionEvent(event, canonicalThreadId) ??
    mapThreadEvent(event, canonicalThreadId) ??
    mapTurnEvent(event, canonicalThreadId) ??
    mapItemEvent(event, canonicalThreadId) ??
    mapTaskEvent(event, canonicalThreadId) ??
    mapTelemetryEvent(event, canonicalThreadId) ??
    mapInfraEvent(event, canonicalThreadId) ??
    []
  );
}
