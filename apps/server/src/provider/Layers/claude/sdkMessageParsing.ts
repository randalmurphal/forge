/**
 * Pure functions for parsing, extracting, and transforming Claude SDK messages.
 *
 * Every function in this module is standalone — no closure dependencies on the
 * adapter runtime. Functions may reference each other and types from
 * `./types.ts`.
 *
 * @module claude/sdkMessageParsing
 */
import type { SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  ClaudeCodeEffort,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadTokenUsageSnapshot,
  ThreadId,
  TurnId,
} from "@forgetools/contracts";
import { asRecord } from "@forgetools/shared/narrowing";
import { Cause } from "effect";

import { buildClaudeToolResultDiffFragment } from "../../ClaudeTurnDiff.ts";
import { toMessage } from "../../adapterUtils.ts";
import type {
  ClaudeResumeState,
  ClaudeSessionContext,
  ClaudeTextStreamKind,
  ClaudeToolResultStreamKind,
  ToolInFlight,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Identifier helpers
// ---------------------------------------------------------------------------

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isSyntheticClaudeThreadId(value: string): boolean {
  return value.startsWith("claude-thread-");
}

export function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(value);
}

export function asCanonicalTurnId(value: TurnId): TurnId {
  return value;
}

export function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(value);
}

// ---------------------------------------------------------------------------
// Error / cause helpers
// ---------------------------------------------------------------------------

export function toError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(toMessage(cause, fallback));
}

export function normalizeClaudeStreamMessages(cause: Cause.Cause<Error>): ReadonlyArray<string> {
  const errors = Cause.prettyErrors(cause)
    .map((error) => error.message.trim())
    .filter((message) => message.length > 0);
  if (errors.length > 0) {
    return errors;
  }

  const squashed = toMessage(Cause.squash(cause), "").trim();
  return squashed.length > 0 ? [squashed] : [];
}

export function isClaudeInterruptedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("all fibers interrupted without error") ||
    normalized.includes("request was aborted") ||
    normalized.includes("interrupted by user")
  );
}

export function isClaudeInterruptedCause(cause: Cause.Cause<Error>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) ||
    normalizeClaudeStreamMessages(cause).some(isClaudeInterruptedMessage)
  );
}

export function messageFromClaudeStreamCause(cause: Cause.Cause<Error>, fallback: string): string {
  return normalizeClaudeStreamMessages(cause)[0] ?? fallback;
}

export function interruptionMessageFromClaudeCause(cause: Cause.Cause<Error>): string {
  const message = messageFromClaudeStreamCause(cause, "Claude runtime interrupted.");
  return isClaudeInterruptedMessage(message) ? "Claude runtime interrupted." : message;
}

export function resultErrorsText(result: SDKResultMessage): string {
  return "errors" in result && Array.isArray(result.errors)
    ? result.errors.join(" ").toLowerCase()
    : "";
}

export function isInterruptedResult(result: SDKResultMessage): boolean {
  const errors = resultErrorsText(result);
  if (errors.includes("interrupt")) {
    return true;
  }

  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    (errors.includes("request was aborted") ||
      errors.includes("interrupted by user") ||
      errors.includes("aborted"))
  );
}

// ---------------------------------------------------------------------------
// Effort
// ---------------------------------------------------------------------------

export function getEffectiveClaudeCodeEffort(
  effort: ClaudeCodeEffort | null | undefined,
): Exclude<ClaudeCodeEffort, "ultrathink"> | null {
  if (!effort) {
    return null;
  }
  return effort === "ultrathink" ? null : effort;
}

// ---------------------------------------------------------------------------
// SDK message field accessors
// ---------------------------------------------------------------------------

/**
 * Safely read `parent_tool_use_id` from an SDK message. Not all message types
 * carry this field, so we access it dynamically.
 */
export function sdkParentToolUseId(message: SDKMessage): string | null {
  const raw = (message as Record<string, unknown>).parent_tool_use_id;
  return typeof raw === "string" ? raw : null;
}

/**
 * Safely read `tool_use_id` from an SDK message (present on task_started /
 * task_progress / task_notification system messages).
 */
export function sdkToolUseId(message: SDKMessage): string | null {
  const raw = (message as Record<string, unknown>).tool_use_id;
  return typeof raw === "string" ? raw : null;
}

export function sdkMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { type?: unknown };
  return typeof record.type === "string" ? record.type : undefined;
}

export function sdkMessageSubtype(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { subtype?: unknown };
  return typeof record.subtype === "string" ? record.subtype : undefined;
}

export function sdkNativeMethod(message: SDKMessage): string {
  const subtype = sdkMessageSubtype(message);
  if (subtype) {
    return `claude/${message.type}/${subtype}`;
  }

  if (message.type === "stream_event") {
    const streamType = sdkMessageType(message.event);
    if (streamType) {
      const deltaType =
        streamType === "content_block_delta"
          ? sdkMessageType((message.event as { delta?: unknown }).delta)
          : undefined;
      if (deltaType) {
        return `claude/${message.type}/${streamType}/${deltaType}`;
      }
      return `claude/${message.type}/${streamType}`;
    }
  }

  return `claude/${message.type}`;
}

export function sdkNativeItemId(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    const maybeId = (message.message as { id?: unknown }).id;
    if (typeof maybeId === "string") {
      return maybeId;
    }
    return undefined;
  }

  if (message.type === "user") {
    return toolResultBlocksFromUserMessage(message)[0]?.toolUseId;
  }

  if (message.type === "stream_event") {
    const event = message.event as {
      type?: unknown;
      content_block?: { id?: unknown };
    };
    if (event.type === "content_block_start" && typeof event.content_block?.id === "string") {
      return event.content_block.id;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Child thread attribution
// ---------------------------------------------------------------------------

/**
 * Build a `childThreadAttribution` payload fragment when the given parent tool
 * use ID references a tracked active subagent tool call.
 */
export function buildChildThreadAttribution(
  context: ClaudeSessionContext,
  parentToolUseId: string | null,
): Record<string, unknown> | undefined {
  if (!parentToolUseId) return undefined;
  const parent = context.activeSubagentTools.get(parentToolUseId);
  if (!parent) return undefined;
  return {
    childProviderThreadId: parentToolUseId,
    taskId: parent.toolUseId,
    label: parent.label,
    ...(parent.agentType ? { agentType: parent.agentType } : {}),
    ...(parent.agentModel ? { agentModel: parent.agentModel } : {}),
  };
}

// ---------------------------------------------------------------------------
// Token usage / context window
// ---------------------------------------------------------------------------

export function maxClaudeContextWindowFromModelUsage(modelUsage: unknown): number | undefined {
  if (!modelUsage || typeof modelUsage !== "object") {
    return undefined;
  }

  let maxContextWindow: number | undefined;
  for (const value of Object.values(modelUsage as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const contextWindow = (value as { contextWindow?: unknown }).contextWindow;
    if (
      typeof contextWindow !== "number" ||
      !Number.isFinite(contextWindow) ||
      contextWindow <= 0
    ) {
      continue;
    }
    maxContextWindow = Math.max(maxContextWindow ?? 0, contextWindow);
  }

  return maxContextWindow;
}

export function normalizeClaudeTokenUsage(
  usage: unknown,
  contextWindow?: number,
): ThreadTokenUsageSnapshot | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const record = usage as Record<string, unknown>;
  const directUsedTokens =
    typeof record.total_tokens === "number" && Number.isFinite(record.total_tokens)
      ? record.total_tokens
      : undefined;
  const inputTokens =
    (typeof record.input_tokens === "number" && Number.isFinite(record.input_tokens)
      ? record.input_tokens
      : 0) +
    (typeof record.cache_creation_input_tokens === "number" &&
    Number.isFinite(record.cache_creation_input_tokens)
      ? record.cache_creation_input_tokens
      : 0) +
    (typeof record.cache_read_input_tokens === "number" &&
    Number.isFinite(record.cache_read_input_tokens)
      ? record.cache_read_input_tokens
      : 0);
  const outputTokens =
    typeof record.output_tokens === "number" && Number.isFinite(record.output_tokens)
      ? record.output_tokens
      : 0;
  const derivedUsedTokens = inputTokens + outputTokens;
  const usedTokens = directUsedTokens ?? (derivedUsedTokens > 0 ? derivedUsedTokens : undefined);
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? { maxTokens: contextWindow }
      : {}),
    ...(typeof record.tool_uses === "number" && Number.isFinite(record.tool_uses)
      ? { toolUses: record.tool_uses }
      : {}),
    ...(typeof record.duration_ms === "number" && Number.isFinite(record.duration_ms)
      ? { durationMs: record.duration_ms }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Resume state
// ---------------------------------------------------------------------------

export function readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as {
    threadId?: unknown;
    resume?: unknown;
    sessionId?: unknown;
    resumeSessionAt?: unknown;
    turnCount?: unknown;
  };

  const threadIdCandidate = typeof cursor.threadId === "string" ? cursor.threadId : undefined;
  const threadId =
    threadIdCandidate && !isSyntheticClaudeThreadId(threadIdCandidate)
      ? ThreadId.makeUnsafe(threadIdCandidate)
      : undefined;
  const resumeCandidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;
  const resume = resumeCandidate && isUuid(resumeCandidate) ? resumeCandidate : undefined;
  const resumeSessionAt =
    typeof cursor.resumeSessionAt === "string" ? cursor.resumeSessionAt : undefined;
  const turnCountValue = typeof cursor.turnCount === "number" ? cursor.turnCount : undefined;

  return {
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnCountValue !== undefined && Number.isInteger(turnCountValue) && turnCountValue >= 0
      ? { turnCount: turnCountValue }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Turn / stream helpers
// ---------------------------------------------------------------------------

export function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus {
  if (result.subtype === "success") {
    return "completed";
  }

  const errors = resultErrorsText(result);
  if (isInterruptedResult(result)) {
    return "interrupted";
  }
  if (errors.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

export function streamKindFromDeltaType(deltaType: string): ClaudeTextStreamKind {
  return deltaType.includes("thinking") ? "reasoning_text" : "assistant_text";
}

export function nativeProviderRefs(
  _context: ClaudeSessionContext,
  options?: {
    readonly providerItemId?: string | undefined;
  },
): NonNullable<ProviderRuntimeEvent["providerRefs"]> {
  if (options?.providerItemId) {
    return {
      providerItemId: ProviderItemId.makeUnsafe(options.providerItemId),
    };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

export function extractAssistantTextBlocks(message: SDKMessage): Array<string> {
  if (message.type !== "assistant") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const fragments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (
      candidate.type === "text" &&
      typeof candidate.text === "string" &&
      candidate.text.length > 0
    ) {
      fragments.push(candidate.text);
    }
  }

  return fragments;
}

export function extractContentBlockText(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }

  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
}

export function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => extractTextContent(entry)).join("");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    content?: unknown;
  };

  if (typeof record.text === "string") {
    return record.text;
  }

  return extractTextContent(record.content);
}

// ---------------------------------------------------------------------------
// Tool use result helpers
// ---------------------------------------------------------------------------

export function readToolUseResultId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const toolUseId = record.tool_use_id;
  if (typeof toolUseId === "string" && toolUseId.length > 0) {
    return toolUseId;
  }

  const camelToolUseId = record.toolUseId;
  if (typeof camelToolUseId === "string" && camelToolUseId.length > 0) {
    return camelToolUseId;
  }

  return undefined;
}

export function indexToolUseResults(value: unknown): Map<string, unknown> {
  const resultsById = new Map<string, unknown>();

  const addResult = (candidate: unknown, fallbackId?: string) => {
    const explicitId = readToolUseResultId(candidate);
    const toolUseId = explicitId ?? fallbackId;
    if (!toolUseId || resultsById.has(toolUseId)) {
      return;
    }
    resultsById.set(toolUseId, candidate);
  };

  if (Array.isArray(value)) {
    for (const entry of value) {
      addResult(entry);
    }
    return resultsById;
  }

  const record = asRecord(value);
  if (!record) {
    return resultsById;
  }

  addResult(record);
  for (const [key, entry] of Object.entries(record)) {
    addResult(entry, key);
  }

  return resultsById;
}

export function resolveSdkToolUseResult(input: {
  readonly messageToolUseResult: unknown;
  readonly block: Record<string, unknown>;
  readonly totalToolResultBlocks: number;
}): unknown {
  if ("tool_use_result" in input.block) {
    return input.block.tool_use_result;
  }

  const toolUseId =
    typeof input.block.tool_use_id === "string" ? input.block.tool_use_id : undefined;
  if (!toolUseId) {
    return input.totalToolResultBlocks === 1 ? input.messageToolUseResult : undefined;
  }

  const indexedResults = indexToolUseResults(input.messageToolUseResult);
  if (indexedResults.has(toolUseId)) {
    return indexedResults.get(toolUseId);
  }

  return input.totalToolResultBlocks === 1 ? input.messageToolUseResult : undefined;
}

export function buildClaudeToolResultPatch(input: {
  readonly cwd?: string;
  readonly sdkToolUseResult: unknown;
}): string | null {
  return buildClaudeToolResultDiffFragment(
    input.cwd
      ? {
          cwd: input.cwd,
          toolUseResult: input.sdkToolUseResult,
        }
      : {
          toolUseResult: input.sdkToolUseResult,
        },
  );
}

export function buildClaudeToolResultData(input: {
  readonly tool: ToolInFlight;
  readonly toolResultBlock: Record<string, unknown>;
  readonly sdkToolUseResult: unknown;
  readonly cwd?: string;
}): Record<string, unknown> {
  const data: Record<string, unknown> = {
    toolName: input.tool.toolName,
    input: input.tool.input,
    result: input.toolResultBlock,
  };

  if (input.sdkToolUseResult === undefined) {
    return data;
  }

  // Claude's structured tool_use_result carries background task ids for Bash and terminal
  // metadata that is not present on the text-only tool_result block. Keep it for every tool so
  // the web layer can correlate later task_* lifecycle events back to the originating tool call.
  data.toolUseResult = input.sdkToolUseResult;

  if (input.tool.itemType !== "file_change") {
    return data;
  }

  const unifiedDiff = buildClaudeToolResultPatch({
    sdkToolUseResult: input.sdkToolUseResult,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  });
  if (typeof unifiedDiff === "string" && unifiedDiff.trim().length > 0) {
    data.unifiedDiff = unifiedDiff;
  }

  return data;
}

export function readClaudeToolResultStatus(value: unknown): string | undefined {
  const record = asRecord(value);
  return typeof record?.status === "string" ? record.status : undefined;
}

export function shouldKeepClaudeSubagentTrackingAfterToolResult(input: {
  readonly tool: ToolInFlight;
  readonly sdkToolUseResult: unknown;
}): boolean {
  if (input.tool.itemType !== "collab_agent_tool_call") {
    return false;
  }

  // Claude background Agent calls complete the launch tool immediately with
  // `status: "async_launched"`, then continue emitting task_* lifecycle and child
  // events keyed by the original tool_use_id. Keep this tool_use_id registered until
  // the later terminal task_notification arrives, otherwise the web layer loses the
  // childThreadAttribution it needs to move the spawned agent from running to completed.
  return readClaudeToolResultStatus(input.sdkToolUseResult) === "async_launched";
}

// ---------------------------------------------------------------------------
// Plan mode
// ---------------------------------------------------------------------------

export function extractExitPlanModePlan(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    plan?: unknown;
  };
  return typeof record.plan === "string" && record.plan.trim().length > 0
    ? record.plan.trim()
    : undefined;
}

export function exitPlanCaptureKey(input: {
  readonly toolUseId?: string | undefined;
  readonly planMarkdown: string;
}): string {
  return input.toolUseId && input.toolUseId.length > 0
    ? `tool:${input.toolUseId}`
    : `plan:${input.planMarkdown}`;
}

// ---------------------------------------------------------------------------
// JSON / input helpers
// ---------------------------------------------------------------------------

export function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function toolInputFingerprint(input: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(input);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tool result stream kind
// ---------------------------------------------------------------------------

export function toolResultStreamKind(
  itemType: CanonicalItemType,
): ClaudeToolResultStreamKind | undefined {
  switch (itemType) {
    case "command_execution":
      return "command_output";
    case "file_change":
      return "file_change_output";
    default:
      return undefined;
  }
}

export function toolResultBlocksFromUserMessage(message: SDKMessage): Array<{
  readonly toolUseId: string;
  readonly block: Record<string, unknown>;
  readonly text: string;
  readonly isError: boolean;
  readonly sdkToolUseResult: unknown;
}> {
  if (message.type !== "user") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const toolResultContentBlocks = content.filter(
    (entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === "object" && (entry as { type?: unknown }).type === "tool_result",
  );
  const messageToolUseResult = (message as SDKUserMessage).tool_use_result;
  const blocks: Array<{
    readonly toolUseId: string;
    readonly block: Record<string, unknown>;
    readonly text: string;
    readonly isError: boolean;
    readonly sdkToolUseResult: unknown;
  }> = [];

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const block = entry as Record<string, unknown>;
    if (block.type !== "tool_result") {
      continue;
    }

    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    if (!toolUseId) {
      continue;
    }

    blocks.push({
      toolUseId,
      block,
      text: extractTextContent(block.content),
      isError: block.is_error === true,
      sdkToolUseResult: resolveSdkToolUseResult({
        messageToolUseResult,
        block,
        totalToolResultBlocks: toolResultContentBlocks.length,
      }),
    });
  }

  return blocks;
}
