/**
 * Pure utility functions for constructing runtime events and converting IDs.
 *
 * All functions in this module are stateless and side-effect-free (except for
 * debug logging in `mapItemLifecycle`). Extracted from CodexAdapter.ts.
 *
 * @module codex/eventHelpers
 */
import type {
  CanonicalItemType,
  CanonicalRequestType,
  ProviderEvent,
  ProviderRuntimeEvent,
  ProviderUserInputAnswers,
  ThreadTokenUsageSnapshot,
} from "@forgetools/contracts";
import {
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@forgetools/contracts";

import {
  asArray,
  asFiniteNumber,
  asRecord,
  asString,
  truncateDetail,
} from "@forgetools/shared/narrowing";

import { logBackgroundDebug } from "../../adapterUtils.ts";
import { FATAL_CODEX_STDERR_SNIPPETS, PROPOSED_PLAN_BLOCK_REGEX } from "./types.ts";

// ---------------------------------------------------------------------------
// ID converters
// ---------------------------------------------------------------------------

export function toTurnId(value: string | undefined): TurnId | undefined {
  const trimmed = value?.trim();
  return trimmed ? TurnId.makeUnsafe(trimmed) : undefined;
}

export function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return value?.trim() ? ProviderItemId.makeUnsafe(value) : undefined;
}

export function toTurnStatus(value: unknown): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

export function asRuntimeItemId(itemId: ProviderItemId): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(itemId);
}

export function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(requestId);
}

export function asRuntimeTaskId(taskId: string): RuntimeTaskId {
  return RuntimeTaskId.makeUnsafe(taskId);
}

// ---------------------------------------------------------------------------
// Item type helpers
// ---------------------------------------------------------------------------

export function normalizeItemType(raw: unknown): string {
  const type = asString(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function toCanonicalItemType(raw: unknown): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file read")) return "file_read";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("search") || type.includes("grep") || type.includes("glob")) return "search";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered")) return "review_entered";
  if (type.includes("review exited")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

export function itemTitle(itemType: CanonicalItemType): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Command";
    case "file_change":
      return "File change";
    case "file_read":
      return "File read";
    case "search":
      return "Search";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

export function itemDetail(
  item: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | undefined {
  const nestedResult = asRecord(item.result);
  const candidates = [
    asString(item.command),
    asString(item.title),
    asString(item.summary),
    asString(item.text),
    asString(item.path),
    asString(item.prompt),
    asString(nestedResult?.command),
    asString(payload.command),
    asString(payload.message),
    asString(payload.prompt),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Event base constructors
// ---------------------------------------------------------------------------

export function eventRawSource(
  event: ProviderEvent,
): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

export function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

export function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

export function codexEventMessage(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return asRecord(payload?.msg);
}

export function codexEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const payload = asRecord(event.payload);
  const msg = codexEventMessage(payload);
  const turnId = event.turnId ?? toTurnId(asString(msg?.turn_id) ?? asString(msg?.turnId));
  const itemId = event.itemId ?? toProviderItemId(asString(msg?.item_id) ?? asString(msg?.itemId));
  const requestId = asString(msg?.request_id) ?? asString(msg?.requestId);
  const base = runtimeEventBase(event, canonicalThreadId);
  const providerRefs = base.providerRefs
    ? {
        ...base.providerRefs,
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: itemId } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      }
    : {
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: itemId } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      };

  return {
    ...base,
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId: asRuntimeItemId(itemId) } : {}),
    ...(requestId ? { requestId: asRuntimeRequestId(requestId) } : {}),
    ...(Object.keys(providerRefs).length > 0 ? { providerRefs } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool name extraction
// ---------------------------------------------------------------------------

export function extractToolName(source: Record<string, unknown>): string | undefined {
  // Try common fields that carry a tool name in Codex payloads
  const candidates = [source.tool, source.name, source.toolName, source.type];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) {
      return c.trim();
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Item lifecycle mapper
// ---------------------------------------------------------------------------

export function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload = asRecord(event.payload);
  const item = asRecord(payload?.item);
  const source = item ?? payload;
  if (!source) {
    return undefined;
  }

  const rawItemType = toCanonicalItemType(source.type ?? source.kind);
  // Unrecognized item types are treated as dynamic_tool_call so new tools
  // from provider updates are visible in the UI rather than silently dropped.
  // This matches the Claude adapter's classifyToolItemType fallback behavior.
  const itemType = rawItemType === "unknown" ? "dynamic_tool_call" : rawItemType;

  const detail = itemDetail(source, payload ?? {});
  const status =
    lifecycle === "item.started"
      ? "inProgress"
      : lifecycle === "item.completed"
        ? "completed"
        : undefined;
  const toolName = extractToolName(source);
  const childThreadAttribution = asRecord(payload?._childThreadAttribution);

  if (itemType === "command_execution" || itemType === "collab_agent_tool_call") {
    const runtimeItem = asRecord(payload?.item);
    logBackgroundDebug("adapter", "itemLifecycle", {
      lifecycle,
      method: event.method,
      canonicalThreadId,
      turnId: event.turnId ?? null,
      itemType,
      itemId: asString(payload?.itemId) ?? asString(source.id) ?? null,
      source: asString(runtimeItem?.source) ?? asString(source.source) ?? null,
      processId: asString(runtimeItem?.processId) ?? asString(source.processId) ?? null,
      status:
        asString(payload?.status) ??
        asString(runtimeItem?.status) ??
        asString(source.status) ??
        null,
      hasChildThreadAttribution: childThreadAttribution !== undefined,
      rawSnapshot: summarizeCommandLifecyclePayloadDebug({
        payload,
        source,
      }),
    });
  }

  return {
    ...runtimeEventBase(event, canonicalThreadId),
    type: lifecycle,
    payload: {
      itemType,
      ...(status ? { status } : {}),
      ...(itemTitle(itemType) ? { title: itemTitle(itemType) } : {}),
      ...(toolName ? { toolName } : {}),
      ...(detail ? { detail } : {}),
      ...(event.payload !== undefined ? { data: event.payload } : {}),
      ...(childThreadAttribution ? { childThreadAttribution } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Fatal stderr detection
// ---------------------------------------------------------------------------

export function isFatalCodexProcessStderrMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return FATAL_CODEX_STDERR_SNIPPETS.some((snippet) => normalized.includes(snippet));
}

// ---------------------------------------------------------------------------
// Token usage normalization
// ---------------------------------------------------------------------------

export function normalizeCodexTokenUsage(value: unknown): ThreadTokenUsageSnapshot | undefined {
  const usage = asRecord(value);
  const totalUsage = asRecord(usage?.total_token_usage ?? usage?.total);
  const lastUsage = asRecord(usage?.last_token_usage ?? usage?.last);

  const totalProcessedTokens =
    asFiniteNumber(totalUsage?.total_tokens) ?? asFiniteNumber(totalUsage?.totalTokens);
  const usedTokens =
    asFiniteNumber(lastUsage?.total_tokens) ??
    asFiniteNumber(lastUsage?.totalTokens) ??
    totalProcessedTokens;
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens =
    asFiniteNumber(usage?.model_context_window) ?? asFiniteNumber(usage?.modelContextWindow);
  const inputTokens =
    asFiniteNumber(lastUsage?.input_tokens) ?? asFiniteNumber(lastUsage?.inputTokens);
  const cachedInputTokens =
    asFiniteNumber(lastUsage?.cached_input_tokens) ?? asFiniteNumber(lastUsage?.cachedInputTokens);
  const outputTokens =
    asFiniteNumber(lastUsage?.output_tokens) ?? asFiniteNumber(lastUsage?.outputTokens);
  const reasoningOutputTokens =
    asFiniteNumber(lastUsage?.reasoning_output_tokens) ??
    asFiniteNumber(lastUsage?.reasoningOutputTokens);

  return {
    usedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(usedTokens !== undefined ? { lastUsedTokens: usedTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    compactsAutomatically: true,
  };
}

// ---------------------------------------------------------------------------
// Request type converters
// ---------------------------------------------------------------------------

export function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/permissions/requestApproval":
      return "permission_approval";
    case "mcpServer/elicitation/request":
      return "mcp_elicitation";
    case "item/tool/call":
    case "dynamicToolCall":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

export function toRequestTypeFromKind(kind: unknown): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

export function toRequestTypeFromResolvedPayload(
  payload: Record<string, unknown> | undefined,
): CanonicalRequestType {
  const request = asRecord(payload?.request);
  const method = asString(request?.method) ?? asString(payload?.method);
  if (method) {
    return toRequestTypeFromMethod(method);
  }
  const requestKind = asString(request?.kind) ?? asString(payload?.requestKind);
  if (requestKind) {
    return toRequestTypeFromKind(requestKind);
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// User input helpers
// ---------------------------------------------------------------------------

export function toCanonicalUserInputAnswers(
  answers: ProviderUserInputAnswers | undefined,
): ProviderUserInputAnswers {
  if (!answers) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(answers).flatMap(([questionId, value]) => {
      if (typeof value === "string") {
        return [[questionId, value] as const];
      }

      if (Array.isArray(value)) {
        const normalized = value.filter((entry): entry is string => typeof entry === "string");
        return [[questionId, normalized.length === 1 ? normalized[0] : normalized] as const];
      }

      const answerObject = asRecord(value);
      const answerList = asArray(answerObject?.answers)?.filter(
        (entry): entry is string => typeof entry === "string",
      );
      if (!answerList) {
        return [];
      }
      return [[questionId, answerList.length === 1 ? answerList[0] : answerList] as const];
    }),
  );
}

export function toUserInputQuestions(payload: Record<string, unknown> | undefined) {
  const questions = asArray(payload?.questions);
  if (!questions) {
    return undefined;
  }

  const parsedQuestions = questions
    .map((entry) => {
      const question = asRecord(entry);
      if (!question) return undefined;
      const options = asArray(question.options)
        ?.map((option) => {
          const optionRecord = asRecord(option);
          if (!optionRecord) return undefined;
          const label = asString(optionRecord.label)?.trim();
          const description = asString(optionRecord.description)?.trim();
          if (!label || !description) {
            return undefined;
          }
          return { label, description };
        })
        .filter((option): option is { label: string; description: string } => option !== undefined);
      const id = asString(question.id)?.trim();
      const header = asString(question.header)?.trim();
      const prompt = asString(question.question)?.trim();
      if (!id || !header || !prompt || !options || options.length === 0) {
        return undefined;
      }
      return {
        id,
        header,
        question: prompt,
        options,
      };
    })
    .filter(
      (
        question,
      ): question is {
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description: string }>;
      } => question !== undefined,
    );

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

// ---------------------------------------------------------------------------
// Thread state and content stream helpers
// ---------------------------------------------------------------------------

export function toThreadState(
  value: unknown,
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  switch (value) {
    case "idle":
      return "idle";
    case "archived":
      return "archived";
    case "closed":
      return "closed";
    case "compacted":
      return "compacted";
    case "error":
    case "failed":
      return "error";
    default:
      return "active";
  }
}

export function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

// ---------------------------------------------------------------------------
// Plan extraction
// ---------------------------------------------------------------------------

export function extractProposedPlanMarkdown(text: string | undefined): string | undefined {
  const match = text ? PROPOSED_PLAN_BLOCK_REGEX.exec(text) : null;
  const planMarkdown = match?.[1]?.trim();
  return planMarkdown && planMarkdown.length > 0 ? planMarkdown : undefined;
}

// ---------------------------------------------------------------------------
// Debug helpers
// ---------------------------------------------------------------------------

export function summarizeRecordKeys(
  value: Record<string, unknown> | undefined,
): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const keys = Object.keys(value).toSorted();
  return keys.length > 0 ? keys : undefined;
}

export function normalizeDebugCommandValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return truncateDetail(value.trim(), 220);
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const parts = value
    .map((entry) => (typeof entry === "string" && entry.trim().length > 0 ? entry.trim() : null))
    .filter((entry): entry is string => entry !== null);
  if (parts.length === 0) {
    return undefined;
  }

  return truncateDetail(parts.join(" "), 220);
}

export function summarizeDebugStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const values = value
    .map((entry) => (typeof entry === "string" && entry.trim().length > 0 ? entry.trim() : null))
    .filter((entry): entry is string => entry !== null);
  return values.length > 0 ? values : undefined;
}

export function summarizeCollabAgentStates(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const statuses = Object.entries(record)
    .map(([threadId, rawState]) => {
      const state = asRecord(rawState);
      const status = asString(state?.status);
      return threadId.trim().length > 0 && status ? ([threadId, status] as const) : null;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null);

  return statuses.length > 0 ? Object.fromEntries(statuses) : undefined;
}

export function summarizeCommandLifecyclePayloadDebug(input: {
  payload: Record<string, unknown> | undefined;
  source: Record<string, unknown>;
}): Record<string, unknown> {
  const payload = input.payload;
  const item = asRecord(payload?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const receiverThreadIds = summarizeDebugStringArray(item?.receiverThreadIds);
  const collabAgentStates = summarizeCollabAgentStates(item?.agentsStates);

  const runInBackground =
    payload?.run_in_background ??
    itemInput?.run_in_background ??
    itemInput?.runInBackground ??
    item?.run_in_background ??
    item?.runInBackground;
  const sessionId =
    asString(payload?.sessionId) ??
    asString(payload?.session_id) ??
    asString(item?.sessionId) ??
    asString(item?.session_id) ??
    asString(itemResult?.sessionId) ??
    asString(itemResult?.session_id);

  return {
    ...(summarizeRecordKeys(payload) ? { payloadKeys: summarizeRecordKeys(payload) } : {}),
    ...(summarizeRecordKeys(item) ? { itemKeys: summarizeRecordKeys(item) } : {}),
    ...(summarizeRecordKeys(itemInput) ? { inputKeys: summarizeRecordKeys(itemInput) } : {}),
    ...(summarizeRecordKeys(itemResult) ? { resultKeys: summarizeRecordKeys(itemResult) } : {}),
    ...((asString(item?.source) ?? asString(input.source.source))
      ? { itemSource: asString(item?.source) ?? asString(input.source.source) }
      : {}),
    ...((asString(item?.processId) ?? asString(input.source.processId))
      ? { processId: asString(item?.processId) ?? asString(input.source.processId) }
      : {}),
    ...((asString(item?.status) ?? asString(input.source.status))
      ? { itemStatus: asString(item?.status) ?? asString(input.source.status) }
      : {}),
    ...((asString(item?.tool) ?? asString(input.source.tool))
      ? { tool: asString(item?.tool) ?? asString(input.source.tool) }
      : {}),
    ...(receiverThreadIds ? { receiverThreadIds } : {}),
    ...(collabAgentStates ? { agentsStates: collabAgentStates } : {}),
    ...(normalizeDebugCommandValue(item?.command)
      ? { itemCommand: normalizeDebugCommandValue(item?.command) }
      : {}),
    ...(normalizeDebugCommandValue(itemInput?.command)
      ? { inputCommand: normalizeDebugCommandValue(itemInput?.command) }
      : {}),
    ...(normalizeDebugCommandValue(itemResult?.command)
      ? { resultCommand: normalizeDebugCommandValue(itemResult?.command) }
      : {}),
    ...(typeof runInBackground === "boolean" ? { runInBackground } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(typeof item?.exitCode === "number" ? { exitCode: item.exitCode } : {}),
    ...(typeof itemResult?.exitCode === "number" ? { resultExitCode: itemResult.exitCode } : {}),
    ...(typeof item?.aggregatedOutput === "string"
      ? { aggregatedOutputLength: item.aggregatedOutput.length }
      : {}),
  };
}
