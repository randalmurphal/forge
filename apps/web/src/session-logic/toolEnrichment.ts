import {
  isToolLifecycleItemType,
  type OrchestrationThreadActivity,
  type OrchestrationToolInlineDiff,
  type TurnId,
} from "@forgetools/contracts";

import { asArray, asRecord, asTrimmedString } from "@forgetools/shared/narrowing";

import type {
  DerivedWorkLogEntry,
  ToolEnrichments,
  ToolInlineDiffSummary,
  WorkLogEntry,
} from "./types";
import type { TurnDiffFileChange } from "../types";
import { requestKindFromRequestType } from "./approvals";
import { isVisibleCollabControlWorkEntry } from "./subagentGrouping";
import { normalizeCompactToolLabel } from "./utils";

export function extractToolEnrichments(
  payload: Record<string, unknown> | null | undefined,
): ToolEnrichments {
  const enrichments: ToolEnrichments = {};
  if (!payload) return enrichments;

  // toolName from payload level (set by ingestion from ItemLifecyclePayload.toolName)
  const payloadToolName = asTrimmedString(payload.toolName);
  if (payloadToolName) {
    enrichments.toolName = payloadToolName;
  }

  const data = asRecord(payload.data);
  if (!data) return enrichments;

  // Claude shape: { toolName, input, result? }
  const claudeToolName = asTrimmedString(data.toolName);
  if (claudeToolName && !enrichments.toolName) {
    enrichments.toolName = claudeToolName;
  }

  const claudeInput = asRecord(data.input);
  const claudeResult = asRecord(data.result);
  const claudeToolUseResult = asRecord(data.toolUseResult);

  // Codex shape: { item: { type, command, output, exitCode, durationMs, ... }, ... }
  const codexItem = asRecord(data.item);
  const codexResult = asRecord(codexItem?.result);
  const codexInput = asRecord(codexItem?.input);
  const codexToolName = asTrimmedString(codexItem?.tool);

  if (codexToolName && !enrichments.toolName) {
    enrichments.toolName = codexToolName;
  }

  // Exit code
  const exitCodeCandidates = [
    codexItem?.exitCode,
    claudeResult?.exit_code,
    claudeResult?.exitCode,
    codexResult?.exitCode,
  ];
  for (const candidate of exitCodeCandidates) {
    if (typeof candidate === "number" && Number.isInteger(candidate)) {
      enrichments.exitCode = candidate;
      break;
    }
  }

  // Duration
  const durationCandidates = [codexItem?.durationMs, data.durationMs];
  for (const candidate of durationCandidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      enrichments.durationMs = candidate;
      break;
    }
  }

  const finalOutputCandidates = [
    normalizeCommandOutputValue(codexItem?.aggregatedOutput),
    normalizeCommandOutputValue(claudeResult?.output),
    joinCommandOutputParts(
      normalizeCommandOutputValue(claudeResult?.stdout),
      normalizeCommandOutputValue(claudeResult?.stderr),
    ),
    normalizeCommandOutputValue(claudeResult?.stdout),
    normalizeCommandOutputValue(codexResult?.output),
  ];
  for (const candidate of finalOutputCandidates) {
    if (!candidate) {
      continue;
    }
    enrichments.output = candidate;
    enrichments.hasOutput = true;
    enrichments.outputByteLength = candidate.length;
    enrichments.outputSource = "final";
    break;
  }

  const outputSummary = asRecord(payload.outputSummary);
  if (outputSummary?.available === true) {
    const source =
      outputSummary.source === "final" || outputSummary.source === "stream"
        ? outputSummary.source
        : null;
    const byteLength =
      typeof outputSummary.byteLength === "number" && Number.isFinite(outputSummary.byteLength)
        ? outputSummary.byteLength
        : null;
    if (source) {
      enrichments.hasOutput = true;
      enrichments.outputSource = source;
    }
    if (byteLength !== null && byteLength >= 0) {
      enrichments.outputByteLength = byteLength;
    }
  }

  if (enrichments.exitCode === undefined) {
    const outputWithExitCodeCandidates = [
      typeof claudeResult?.output === "string" ? claudeResult.output : null,
      typeof codexResult?.output === "string" ? codexResult.output : null,
    ];
    for (const candidate of outputWithExitCodeCandidates) {
      if (!candidate) {
        continue;
      }
      const detailInfo = stripTrailingExitCode(candidate);
      if (detailInfo.exitCode !== undefined) {
        enrichments.exitCode = detailInfo.exitCode;
        break;
      }
    }
  }

  if (
    claudeInput?.run_in_background === true ||
    codexInput?.run_in_background === true ||
    data.run_in_background === true ||
    typeof claudeToolUseResult?.backgroundTaskId === "string" ||
    claudeToolUseResult?.backgroundedByUser === true ||
    claudeToolUseResult?.assistantAutoBackgrounded === true
  ) {
    enrichments.isBackgroundCommand = true;
  }

  const backgroundTaskId = asTrimmedString(claudeToolUseResult?.backgroundTaskId);
  if (backgroundTaskId) {
    enrichments.backgroundTaskId = backgroundTaskId;
  }

  const processId = asTrimmedString(codexItem?.processId);
  if (processId) {
    enrichments.processId = processId;
  }

  const commandSource = asTrimmedString(codexItem?.source);
  if (commandSource) {
    enrichments.commandSource = commandSource;
  }

  // MCP server and tool
  // Codex: item.server, item.tool
  // Claude: toolName is like "mcp__serverName__toolName" or just the tool name
  const mcpServer = asTrimmedString(codexItem?.server);
  const mcpTool = asTrimmedString(codexItem?.tool);
  if (mcpServer) {
    enrichments.mcpServer = mcpServer;
  }
  if (mcpTool) {
    enrichments.mcpTool = mcpTool;
  }
  // Parse Claude MCP tool names: mcp__server__tool
  if (!enrichments.mcpServer && enrichments.toolName) {
    const mcpMatch = /^mcp__([^_]+(?:__[^_]+)*)__([^_]+(?:__[^_]+)*)$/.exec(enrichments.toolName);
    if (mcpMatch?.[1] && mcpMatch[2]) {
      enrichments.mcpServer = mcpMatch[1];
      enrichments.mcpTool = mcpMatch[2];
    }
  }

  // Search pattern and result count
  const searchPattern = asTrimmedString(claudeInput?.pattern) ?? asTrimmedString(codexItem?.query);
  if (searchPattern) {
    enrichments.searchPattern = searchPattern;
  }
  // Try to extract result count from grep/glob results
  if (claudeResult) {
    const resultContent = claudeResult.content;
    if (typeof resultContent === "string") {
      const fileMatches = resultContent.match(/\n/g);
      if (fileMatches) {
        enrichments.searchResultCount = fileMatches.length;
      }
    }
  }

  // File path
  const filePathCandidates = [
    claudeInput?.file_path,
    claudeInput?.filePath,
    claudeInput?.path,
    codexItem?.path,
  ];
  for (const candidate of filePathCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      enrichments.filePath = candidate.trim();
      break;
    }
  }

  // Agent/subagent tool call enrichments
  // Claude shape: data.input has { description, subagent_type, model, prompt }
  // Codex shape: data.item has { description, prompt } (no subagent_type or model)
  const agentDescription =
    asTrimmedString(claudeInput?.description) ?? asTrimmedString(codexItem?.description);
  if (agentDescription) {
    enrichments.agentDescription = agentDescription;
  }
  const agentType = asTrimmedString(claudeInput?.subagent_type);
  if (agentType) {
    enrichments.agentType = agentType;
  }
  const agentModel = asTrimmedString(claudeInput?.model) ?? asTrimmedString(codexItem?.model);
  if (agentModel) {
    enrichments.agentModel = agentModel;
  }
  const agentPrompt = asTrimmedString(claudeInput?.prompt) ?? asTrimmedString(codexItem?.prompt);
  if (agentPrompt) {
    enrichments.agentPrompt = agentPrompt;
  }
  const receiverThreadIds =
    asArray(codexItem?.receiverThreadIds)
      ?.map((value) => asTrimmedString(value))
      .filter((value): value is string => value != null) ?? [];
  if (receiverThreadIds.length > 0) {
    enrichments.receiverThreadIds = receiverThreadIds;
  }

  return enrichments;
}

export function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const command = extractToolCommand(payload);
  const title = extractToolTitle(payload);
  const toolCallId = extractToolCallId(payload);
  const detailInfo =
    payload && typeof payload.detail === "string"
      ? stripTrailingExitCode(payload.detail)
      : { output: null as string | null, exitCode: undefined as number | undefined };
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
    startedAt: activity.createdAt,
    ...(activity.kind === "tool.completed" || activity.kind === "task.completed"
      ? { completedAt: activity.createdAt }
      : {}),
    ...(activity.turnId ? { turnId: activity.turnId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    label: activity.summary,
    tone: activity.tone === "approval" ? "info" : activity.tone,
    activityKind: activity.kind,
  };
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  if (detailInfo.output) {
    entry.detail = stripToolNamePrefix(detailInfo.output);
  }
  if (command) {
    entry.command = command;
  }
  if (title) {
    entry.toolTitle = title;
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  const inlineDiff =
    (activity.kind === "tool.updated" || activity.kind === "tool.completed") &&
    (itemType === "file_change" || itemType === "command_execution")
      ? extractPersistedToolInlineDiffSummary({
          activityId: activity.id,
          turnId: activity.turnId ?? undefined,
          toolCallId: toolCallId ?? undefined,
          payload,
          title: title ?? activity.summary,
        })
      : undefined;
  if (inlineDiff) {
    entry.inlineDiff = inlineDiff;
    entry.changedFiles = inlineDiff.files.map((file) => file.path);
  }
  const enrichments = extractToolEnrichments(payload);
  const itemStatus = normalizeWorkItemStatus(payload?.status) ?? deriveActivityItemStatus(activity);
  if (itemStatus) entry.itemStatus = itemStatus;
  if (enrichments.toolName) entry.toolName = enrichments.toolName;
  if (enrichments.exitCode !== undefined) entry.exitCode = enrichments.exitCode;
  else if (detailInfo.exitCode !== undefined) entry.exitCode = detailInfo.exitCode;
  if (enrichments.durationMs !== undefined) entry.durationMs = enrichments.durationMs;
  if (enrichments.output) entry.output = enrichments.output;
  if (enrichments.hasOutput) entry.hasOutput = true;
  if (enrichments.outputByteLength !== undefined)
    entry.outputByteLength = enrichments.outputByteLength;
  if (enrichments.outputSource) entry.outputSource = enrichments.outputSource;
  if (enrichments.isBackgroundCommand) entry.isBackgroundCommand = true;
  if (enrichments.backgroundTaskId) entry.backgroundTaskId = enrichments.backgroundTaskId;
  if (enrichments.processId) entry.processId = enrichments.processId;
  if (enrichments.commandSource) entry.commandSource = enrichments.commandSource;
  if (enrichments.mcpServer) entry.mcpServer = enrichments.mcpServer;
  if (enrichments.mcpTool) entry.mcpTool = enrichments.mcpTool;
  if (enrichments.searchPattern) entry.searchPattern = enrichments.searchPattern;
  if (enrichments.searchResultCount !== undefined)
    entry.searchResultCount = enrichments.searchResultCount;
  if (enrichments.filePath) entry.filePath = enrichments.filePath;
  if (enrichments.agentDescription) entry.agentDescription = enrichments.agentDescription;
  if (enrichments.agentType) entry.agentType = enrichments.agentType;
  if (enrichments.agentModel) entry.agentModel = enrichments.agentModel;
  if (enrichments.agentPrompt) entry.agentPrompt = enrichments.agentPrompt;
  if (enrichments.receiverThreadIds) entry.receiverThreadIds = enrichments.receiverThreadIds;

  // Extract child thread attribution for subagent grouping
  const childThreadAttribution = extractChildThreadAttribution(payload);
  if (childThreadAttribution) {
    entry.childThreadAttribution = childThreadAttribution;
  }

  // For task.progress entries (subagent reasoning updates), extract lastToolName as toolName
  if (
    activity.kind === "task.progress" &&
    !entry.toolName &&
    payload &&
    typeof payload.lastToolName === "string"
  ) {
    entry.toolName = payload.lastToolName;
  }
  const collapseKey = deriveToolLifecycleCollapseKey(entry);
  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }
  return entry;
}

export function extractToolCommand(
  payload: Record<string, unknown> | null | undefined,
): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const dataInput = asRecord(data?.input);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(dataInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
  ];
  return candidates.find((candidate) => candidate != null) ?? null;
}

export function normalizeCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry != null);
  return parts.length > 0 ? parts.join(" ") : null;
}

export function normalizeCommandOutputValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\r\n/g, "\n");
  if (normalized.trim().length === 0) {
    return null;
  }
  return stripTrailingExitCodePreservingOutput(normalized).output;
}

export function joinCommandOutputParts(
  stdout: string | null,
  stderr: string | null,
): string | null {
  if (!stdout && !stderr) {
    return null;
  }
  if (!stdout) {
    return stderr;
  }
  if (!stderr) {
    return stdout;
  }
  if (stdout.endsWith("\n") || stderr.startsWith("\n")) {
    return `${stdout}${stderr}`;
  }
  return `${stdout}\n${stderr}`;
}

export function extractToolTitle(
  payload: Record<string, unknown> | null | undefined,
): string | undefined {
  return asTrimmedString(payload?.title);
}

export function extractToolCallId(
  payload: Record<string, unknown> | null | undefined,
): string | undefined {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const candidates = [
    asTrimmedString(payload?.toolCallId),
    asTrimmedString(payload?.itemId),
    asTrimmedString(data?.toolUseId),
    asTrimmedString(data?.itemId),
    asTrimmedString(item?.id),
    asTrimmedString(item?.itemId),
    asTrimmedString(itemResult?.tool_use_id),
    asTrimmedString(itemResult?.toolUseId),
  ];
  return candidates.find((candidate) => candidate != null) ?? undefined;
}

export function extractCommandSource(
  payload: Record<string, unknown> | null | undefined,
): string | null | undefined {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  return asTrimmedString(item?.source) ?? asTrimmedString(payload?.source);
}

export function extractCommandProcessId(
  payload: Record<string, unknown> | null | undefined,
): string | undefined {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  return asTrimmedString(item?.processId) ?? asTrimmedString(payload?.processId);
}

export function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

export function stripTrailingExitCodePreservingOutput(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(value);
  if (!match?.groups) {
    return {
      output: value,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  return {
    output: match.groups.output ?? "",
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

/**
 * Strip leading tool name prefix from detail strings.
 * Claude adapter produces detail like "Read: /some/file.ts" or "Bash: git status".
 * Since we now display the tool name separately in the heading, the prefix is redundant.
 */
function stripToolNamePrefix(detail: string): string {
  // Match "ToolName: rest" where ToolName is a single PascalCase/camelCase word
  const match = /^[A-Za-z][A-Za-z0-9_-]*:\s+/.exec(detail);
  if (!match) return detail;
  const rest = detail.slice(match[0].length).trim();
  // Only strip if there's meaningful content after the prefix
  return rest.length > 0 ? rest : detail;
}

export function extractWorkLogItemType(
  payload: Record<string, unknown> | null | undefined,
): WorkLogEntry["itemType"] | undefined {
  if (typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)) {
    return payload.itemType;
  }
  return undefined;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null | undefined,
): WorkLogEntry["requestKind"] | undefined {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}

export function normalizeWorkItemStatus(value: unknown): WorkLogEntry["itemStatus"] | undefined {
  switch (value) {
    case "pending":
    case "running":
    case "in_progress":
    case "inProgress":
      return "inProgress";
    case "completed":
    case "shutdown":
      return "completed";
    case "failed":
    case "error":
    case "errored":
    case "interrupted":
    case "notFound":
      return "failed";
    case "declined":
    case "rejected":
      return "declined";
    default:
      return undefined;
  }
}

export function deriveActivityItemStatus(
  activity: OrchestrationThreadActivity,
): WorkLogEntry["itemStatus"] | undefined {
  switch (activity.kind) {
    case "tool.started":
    case "tool.updated":
    case "task.progress":
    case "task.started":
      return "inProgress";
    case "tool.completed":
    case "task.completed":
      return activity.tone === "error" ? "failed" : "completed";
    default:
      return undefined;
  }
}

function extractChildThreadAttribution(
  payload: Record<string, unknown> | null | undefined,
): WorkLogEntry["childThreadAttribution"] {
  if (!payload) return undefined;
  const attr = payload.childThreadAttribution;
  if (!attr || typeof attr !== "object") return undefined;
  const record = attr as Record<string, unknown>;
  const taskId = typeof record.taskId === "string" ? record.taskId : undefined;
  const childProviderThreadId =
    typeof record.childProviderThreadId === "string" ? record.childProviderThreadId : undefined;
  if (!taskId || !childProviderThreadId) return undefined;
  const label = typeof record.label === "string" ? record.label : undefined;
  const agentType =
    typeof record.agentType === "string" && record.agentType.length > 0
      ? record.agentType
      : undefined;
  const agentModel =
    typeof record.agentModel === "string" && record.agentModel.length > 0
      ? record.agentModel
      : undefined;
  return { taskId, childProviderThreadId, label, agentType, agentModel };
}

function normalizeStatValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function toTurnDiffFileChange(
  file: OrchestrationToolInlineDiff["files"][number],
): TurnDiffFileChange | undefined {
  const path = asTrimmedString(file.path);
  if (!path) {
    return undefined;
  }
  const kind = asTrimmedString(file.kind);
  const additions = normalizeStatValue(file.additions);
  const deletions = normalizeStatValue(file.deletions);
  return {
    path,
    ...(kind ? { kind } : {}),
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
  };
}

export function extractPersistedToolInlineDiffSummary(input: {
  activityId: string;
  turnId?: TurnId | undefined;
  toolCallId?: string | undefined;
  payload: Record<string, unknown> | null | undefined;
  title: string;
}): ToolInlineDiffSummary | undefined {
  const inlineDiff = asRecord(input.payload?.inlineDiff);
  if (!inlineDiff || !Array.isArray(inlineDiff.files)) {
    return undefined;
  }

  const availability =
    inlineDiff.availability === "exact_patch" || inlineDiff.availability === "summary_only"
      ? inlineDiff.availability
      : null;
  if (!availability) {
    return undefined;
  }

  const files = inlineDiff.files
    .map((file) => toTurnDiffFileChange(file as OrchestrationToolInlineDiff["files"][number]))
    .filter((file): file is TurnDiffFileChange => file !== undefined);
  if (files.length === 0) {
    return undefined;
  }

  const fileStats = summarizeToolInlineDiffFiles(files);
  const additions = normalizeStatValue(inlineDiff.additions) ?? fileStats.additions;
  const deletions = normalizeStatValue(inlineDiff.deletions) ?? fileStats.deletions;
  return {
    id: input.activityId,
    activityId: input.activityId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    title: input.title,
    files,
    availability,
    ...(typeof inlineDiff.unifiedDiff === "string" && inlineDiff.unifiedDiff.trim().length > 0
      ? { unifiedDiff: inlineDiff.unifiedDiff }
      : {}),
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
  };
}

export function summarizeToolInlineDiffFiles(files: ReadonlyArray<TurnDiffFileChange>): {
  additions?: number | undefined;
  deletions?: number | undefined;
} {
  let additions = 0;
  let deletions = 0;
  let hasStats = false;
  for (const file of files) {
    if (typeof file.additions === "number") {
      additions += file.additions;
      hasStats = true;
    }
    if (typeof file.deletions === "number") {
      deletions += file.deletions;
      hasStats = true;
    }
  }
  return hasStats ? { additions, deletions } : {};
}

function deriveToolLifecycleCollapseKey(entry: DerivedWorkLogEntry): string | undefined {
  if (
    entry.activityKind !== "tool.started" &&
    entry.activityKind !== "tool.updated" &&
    entry.activityKind !== "tool.completed"
  ) {
    return undefined;
  }
  if (
    entry.activityKind === "tool.started" &&
    entry.itemType !== "command_execution" &&
    !isVisibleCollabControlWorkEntry(entry)
  ) {
    return undefined;
  }
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const itemType = entry.itemType ?? "";
  const stableIdentity = deriveToolLifecycleIdentity(entry);
  if (normalizedLabel.length === 0 && stableIdentity.length === 0 && itemType.length === 0) {
    return undefined;
  }
  return [itemType, normalizedLabel, stableIdentity].join("\u001f");
}

function deriveToolLifecycleIdentity(entry: DerivedWorkLogEntry): string {
  if (entry.toolCallId) {
    return `tool:${entry.toolCallId}`;
  }
  if ((entry.changedFiles?.length ?? 0) > 0) {
    return `files:${[...(entry.changedFiles ?? [])].toSorted().join("|")}`;
  }
  const inlineDiffFiles = entry.inlineDiff?.files;
  if (inlineDiffFiles && inlineDiffFiles.length > 0) {
    const inlineDiffPaths = inlineDiffFiles.map((file) => file.path).toSorted();
    return `diff-files:${inlineDiffPaths.join("|")}`;
  }
  const normalizedDetail = entry.detail?.trim() ?? "";
  if (normalizedDetail.length > 0) {
    return normalizedDetail;
  }
  if (entry.command) {
    return `command:${entry.command}`;
  }
  return "";
}
