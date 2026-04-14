import { EventId, type OrchestrationThreadActivity } from "@forgetools/contracts";

import { asRecord, asTrimmedString } from "@forgetools/shared/narrowing";

import type { DerivedWorkLogEntry, WorkLogEntry } from "./types";
import { SUBAGENT_FALLBACK_ENTRY_LIMIT } from "./types";
import { debugLog, isWebDebugEnabled } from "../debug";

const DEBUG_BACKGROUND_TASKS = isWebDebugEnabled("background");

/** Internal grouping structure used to correlate child-thread activities with their
 *  parent agent tool call. Not exported — callers should use
 *  `enrichParentEntriesWithSubagentGroupMetadata` instead. */
interface SubagentGroup {
  groupId: string;
  taskId: string;
  childProviderThreadId: string;
  label: string;
  entries: WorkLogEntry[];
  recordedActionCount: number;
  status: "running" | "completed" | "failed";
  startedAt: string;
  startedSequence?: number | undefined;
  completedAt?: string | undefined;
  completedSequence?: number | undefined;
  agentDescription?: string | undefined;
  agentPrompt?: string | undefined;
  agentType?: string | undefined;
  agentModel?: string | undefined;
}

export function isCodexControlCollabTool(toolName: string | null | undefined): boolean {
  return toolName === "sendInput" || toolName === "wait";
}

function isCodexSpawnCollabTool(toolName: string | null | undefined): boolean {
  return toolName?.toLowerCase() === "spawnagent";
}

export function extractCollabControlToolName(
  payload: Record<string, unknown> | null | undefined,
): string | null | undefined {
  if (!payload) {
    return null;
  }

  const payloadToolName = asTrimmedString(payload.toolName);
  if (payloadToolName) {
    return payloadToolName;
  }

  const data = asRecord(payload.data);
  const dataToolName = asTrimmedString(data?.toolName);
  if (dataToolName) {
    return dataToolName;
  }

  const item = asRecord(data?.item);
  return asTrimmedString(item?.tool);
}

export function isVisibleCollabControlTool(toolName: string | null | undefined): boolean {
  if (!toolName) {
    return false;
  }

  // These are the parent-thread collab control calls we want reflected inline in history.
  // Claude uses `Agent`; Codex uses `spawnAgent` / `wait` / `sendInput` / close-resume controls.
  const normalized = toolName.toLowerCase();
  return (
    normalized === "agent" ||
    normalized === "spawnagent" ||
    normalized === "wait" ||
    normalized === "sendinput" ||
    normalized === "closeagent" ||
    normalized === "resumeagent"
  );
}

export function isVisibleCollabControlWorkEntry(entry: {
  itemType?: DerivedWorkLogEntry["itemType"] | undefined;
  toolName?: string | undefined;
}): boolean {
  // Claude emits user-visible Agent launch rows through the same lifecycle collapse path as Codex
  // spawn/wait controls. If we only whitelist Codex names here, the empty start payload and richer
  // completion payload split into duplicate inline rows instead of one collapsed control entry.
  return (
    entry.itemType === "collab_agent_tool_call" &&
    isVisibleCollabControlTool(entry.toolName ?? null)
  );
}

export function isVisibleInlineToolStartEntry(entry: {
  itemType?: DerivedWorkLogEntry["itemType"] | undefined;
  toolName?: string | undefined;
}): boolean {
  if (entry.itemType === "command_execution") {
    return true;
  }
  if (isVisibleCollabControlWorkEntry(entry)) {
    return true;
  }
  return entry.itemType === "dynamic_tool_call" && entry.toolName === "TaskOutput";
}

export function isUnattributedCollabAgentToolEnvelope(
  activity: OrchestrationThreadActivity,
): boolean {
  if (
    activity.kind !== "tool.started" &&
    activity.kind !== "tool.updated" &&
    activity.kind !== "tool.completed"
  ) {
    return false;
  }
  const payload = asRecord(activity.payload);
  if (payload?.itemType !== "collab_agent_tool_call" || payload.childThreadAttribution) {
    return false;
  }
  // Most unattributed collab envelopes are parent-thread bookkeeping noise and should stay out of
  // the timeline. Keep the user-visible control calls (spawn/wait/sendInput/etc.) inline so the
  // history reflects that those tools were actually invoked.
  return !isVisibleCollabControlTool(extractCollabControlToolName(payload));
}

export function shouldFilterToolStartedActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.started") {
    return false;
  }
  const payload = asRecord(activity.payload);
  return !isVisibleInlineToolStartEntry({
    itemType:
      typeof payload?.itemType === "string"
        ? (payload.itemType as DerivedWorkLogEntry["itemType"])
        : undefined,
    toolName: extractCollabControlToolName(payload) ?? undefined,
  });
}

export function isGenericSubagentLabel(label: string | undefined): boolean {
  if (!label) {
    return false;
  }
  return label === "Subagent" || label.startsWith("Subagent ");
}

export function groupSubagentEntries(workEntries: ReadonlyArray<WorkLogEntry>): {
  standalone: WorkLogEntry[];
  subagentGroups: SubagentGroup[];
} {
  const standalone: WorkLogEntry[] = [];
  const groupsByChildThreadId = new Map<
    string,
    {
      groupId: string;
      taskId: string;
      childProviderThreadId: string;
      entries: WorkLogEntry[];
      label: string | undefined;
      startedAt: string;
      startedSequence?: number;
      completedAt?: string;
      completedSequence?: number;
      status: SubagentGroup["status"];
      agentDescription?: string | undefined;
      agentPrompt?: string | undefined;
      agentType?: string | undefined;
      agentModel?: string | undefined;
    }
  >();

  for (const entry of workEntries) {
    const childThreadAttribution = entry.childThreadAttribution;
    if (!childThreadAttribution) {
      standalone.push(entry);
      continue;
    }

    // Collab control tools (wait, closeAgent, sendInput, resumeAgent) are standalone
    // timeline entries that should render at their actual chronological position, NOT
    // be consumed into a subagent group. Spawn/Agent are the only tool calls that
    // anchor a subagent group.
    if (
      isCodexControlCollabTool(entry.toolName) ||
      entry.toolName?.toLowerCase() === "closeagent" ||
      entry.toolName?.toLowerCase() === "resumeagent"
    ) {
      standalone.push(entry);
      continue;
    }
    const groupId = childThreadAttribution.childProviderThreadId;
    const taskId = childThreadAttribution.taskId;

    let group = groupsByChildThreadId.get(groupId);
    if (!group) {
      const nextGroup: {
        groupId: string;
        taskId: string;
        childProviderThreadId: string;
        entries: WorkLogEntry[];
        label: string | undefined;
        startedAt: string;
        startedSequence?: number;
        completedAt?: string;
        completedSequence?: number;
        status: SubagentGroup["status"];
        agentDescription?: string | undefined;
        agentPrompt?: string | undefined;
        agentType?: string | undefined;
        agentModel?: string | undefined;
      } = {
        groupId,
        taskId,
        childProviderThreadId: childThreadAttribution.childProviderThreadId,
        entries: [],
        label: childThreadAttribution.label ?? undefined,
        startedAt: entry.startedAt ?? entry.createdAt,
        status: "running",
        ...(entry.sequence !== undefined ? { startedSequence: entry.sequence } : {}),
        // agentType/agentModel: prefer childThreadAttribution (set by the server from the
        // parent Agent tool call), fall back to the entry's own enrichment fields (extracted
        // from the event payload by toolEnrichment.ts).
        ...((childThreadAttribution.agentType ?? entry.agentType)
          ? { agentType: childThreadAttribution.agentType ?? entry.agentType }
          : {}),
        ...((childThreadAttribution.agentModel ?? entry.agentModel)
          ? { agentModel: childThreadAttribution.agentModel ?? entry.agentModel }
          : {}),
      };
      groupsByChildThreadId.set(groupId, nextGroup);
      group = nextGroup;
    } else if (
      group.taskId === group.childProviderThreadId &&
      taskId !== group.childProviderThreadId
    ) {
      group.taskId = taskId;
    }
    if (!group) {
      continue;
    }

    // Update group metadata from task lifecycle entries
    if (entry.activityKind === "task.started") {
      group.startedAt = entry.startedAt ?? entry.createdAt;
      if (entry.sequence !== undefined) {
        group.startedSequence = entry.sequence;
      }
      if (!group.label && entry.detail) {
        group.label = entry.detail;
      }
      if (!group.agentPrompt && entry.detail) {
        group.agentPrompt = entry.detail;
      }
    } else if (entry.activityKind === "task.completed") {
      if (!group.completedAt) {
        group.completedAt = entry.createdAt;
      }
      if (group.completedSequence === undefined && entry.sequence !== undefined) {
        group.completedSequence = entry.sequence;
      }
      const completedStatus =
        entry.itemStatus === "failed" || entry.itemStatus === "declined" || entry.tone === "error"
          ? "failed"
          : "completed";
      group.status = group.status === "failed" ? "failed" : completedStatus;
    } else if (entry.activityKind === "task.updated") {
      // task_updated with terminal patch status is a first-class completion signal.
      // The SDK docs say: "Clients merge into their local task map."
      // itemStatus is extracted from patch.status in toDerivedWorkLogEntry.
      const isTerminal =
        entry.itemStatus === "completed" || entry.itemStatus === "failed" || entry.tone === "error";
      if (isTerminal) {
        if (!group.completedAt) {
          group.completedAt = entry.createdAt;
        }
        if (group.completedSequence === undefined && entry.sequence !== undefined) {
          group.completedSequence = entry.sequence;
        }
        const completedStatus =
          entry.itemStatus === "failed" || entry.itemStatus === "declined" || entry.tone === "error"
            ? "failed"
            : "completed";
        group.status = group.status === "failed" ? "failed" : completedStatus;
      }
    } else {
      // Regular work entry for this subagent
      group.entries.push(entry);
    }

    // Update label from attribution if available
    if (childThreadAttribution.label && !group.label) {
      group.label = childThreadAttribution.label;
    }
    if (!group.agentDescription && entry.agentDescription) {
      group.agentDescription = entry.agentDescription;
    }
    if (!group.agentPrompt && entry.agentPrompt) {
      group.agentPrompt = entry.agentPrompt;
    }
    if (!group.agentType) {
      group.agentType = childThreadAttribution.agentType ?? entry.agentType;
    }
    if (!group.agentModel) {
      group.agentModel = childThreadAttribution.agentModel ?? entry.agentModel;
    }
  }

  const subagentGroups: SubagentGroup[] = [];
  for (const group of groupsByChildThreadId.values()) {
    subagentGroups.push({
      groupId: group.groupId,
      taskId: group.taskId,
      childProviderThreadId: group.childProviderThreadId,
      // Provider task ids like `call_xxx` are implementation noise. Keep a generic fallback here
      // and let control-call metadata replace it when we have real description/prompt context.
      label: group.label ?? "Subagent",
      entries: group.entries,
      recordedActionCount: group.entries.length,
      status: group.status,
      startedAt: group.startedAt,
      startedSequence: group.startedSequence,
      completedAt: group.completedAt,
      completedSequence: group.completedSequence,
      agentDescription: group.agentDescription,
      agentPrompt: group.agentPrompt,
      agentType: group.agentType,
      agentModel: group.agentModel,
    });
  }

  return { standalone, subagentGroups };
}

export function synthesizeClaudeTaskOutputLifecycleActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThreadActivity[] {
  const realTerminalTaskIds = new Set<string>();
  const taskContextByTaskId = new Map<
    string,
    {
      toolUseId?: string | undefined;
      childThreadAttribution?: Record<string, unknown> | undefined;
    }
  >();

  for (const activity of activities) {
    const payload = asRecord(activity.payload);
    if (!payload) {
      continue;
    }

    if (
      activity.kind === "task.started" ||
      activity.kind === "task.progress" ||
      activity.kind === "task.completed" ||
      activity.kind === "task.updated"
    ) {
      const taskId = asTrimmedString(payload.taskId);
      if (!taskId) {
        continue;
      }

      const existingContext = taskContextByTaskId.get(taskId) ?? {};
      const nextContext = {
        toolUseId: asTrimmedString(payload.toolUseId) ?? existingContext.toolUseId,
        childThreadAttribution:
          asRecord(payload.childThreadAttribution) ?? existingContext.childThreadAttribution,
      };
      taskContextByTaskId.set(taskId, nextContext);

      if (activity.kind === "task.completed") {
        realTerminalTaskIds.add(taskId);
      }
      if (activity.kind === "task.updated") {
        const patch = asRecord(payload.patch);
        const patchStatus = asTrimmedString(patch?.status);
        if (patchStatus === "completed" || patchStatus === "failed" || patchStatus === "killed") {
          realTerminalTaskIds.add(taskId);
        }
      }
      continue;
    }
  }

  const syntheticActivities: OrchestrationThreadActivity[] = [];
  for (const activity of activities) {
    if (activity.kind !== "tool.completed") {
      continue;
    }

    const resolvedTask = extractClaudeTaskOutputResolvedTask(activity);
    if (!resolvedTask) {
      continue;
    }
    if (realTerminalTaskIds.has(resolvedTask.taskId)) {
      continue;
    }

    const normalizedStatus = normalizeClaudeTaskOutputTaskStatus(resolvedTask.status);
    if (normalizedStatus === "running") {
      continue;
    }

    realTerminalTaskIds.add(resolvedTask.taskId);
    const taskContext = taskContextByTaskId.get(resolvedTask.taskId);
    syntheticActivities.push({
      id: EventId.makeUnsafe(`${activity.id}:synthetic-taskoutput-complete:${resolvedTask.taskId}`),
      tone: normalizedStatus === "failed" ? "error" : "info",
      kind: "task.completed",
      summary: normalizedStatus === "failed" ? "Task failed" : "Task completed",
      payload: {
        taskId: resolvedTask.taskId,
        status: normalizedStatus === "failed" ? "failed" : "completed",
        ...(taskContext?.toolUseId ? { toolUseId: taskContext.toolUseId } : {}),
        ...(resolvedTask.description ? { detail: resolvedTask.description } : {}),
        ...(taskContext?.childThreadAttribution
          ? { childThreadAttribution: taskContext.childThreadAttribution }
          : {}),
      },
      turnId: activity.turnId,
      createdAt: activity.createdAt,
    });
  }

  return syntheticActivities;
}

function extractClaudeTaskOutputResolvedTask(activity: OrchestrationThreadActivity): {
  taskId: string;
  status: string;
  description?: string | undefined;
} | null {
  const payload = asRecord(activity.payload);
  if (!payload) {
    return null;
  }

  const toolName =
    asTrimmedString(payload.toolName) ??
    asTrimmedString(asRecord(payload.data)?.toolName) ??
    asTrimmedString(asRecord(asRecord(payload.data)?.item)?.tool);
  if (toolName !== "TaskOutput") {
    return null;
  }

  const data = asRecord(payload.data);
  const toolUseResult = asRecord(data?.toolUseResult);
  const resolvedTask = asRecord(toolUseResult?.task);
  if (!resolvedTask) {
    return null;
  }

  const taskId = asTrimmedString(resolvedTask.task_id) ?? asTrimmedString(resolvedTask.taskId);
  const status = asTrimmedString(resolvedTask.status);
  if (!taskId || !status) {
    return null;
  }

  return {
    taskId,
    status,
    ...(asTrimmedString(resolvedTask.description)
      ? { description: asTrimmedString(resolvedTask.description) ?? undefined }
      : {}),
  };
}

function normalizeClaudeTaskOutputTaskStatus(status: string): "running" | "completed" | "failed" {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "error":
    case "errored":
    case "stopped":
    case "killed":
    case "interrupted":
      return "failed";
    default:
      return "running";
  }
}

/**
 * Groups child-attributed entries into subagent groups, then attaches group metadata
 * directly onto the matching parent `collab_agent_tool_call` entry instead of producing
 * separate SubagentGroup objects. Returns only standalone entries (child entries are
 * consumed into `subagentGroupMeta` on the parent).
 *
 * Join logic:
 * - Claude: parent `toolCallId` === group `childProviderThreadId`
 * - Codex: parent `receiverThreadIds` contains group `childProviderThreadId`
 */
export function enrichParentEntriesWithSubagentGroupMetadata(
  workEntries: ReadonlyArray<WorkLogEntry>,
): WorkLogEntry[] {
  const { standalone, subagentGroups } = groupSubagentEntries(workEntries);
  if (subagentGroups.length === 0) {
    return [...standalone];
  }

  if (DEBUG_BACKGROUND_TASKS) {
    debugLog({
      topic: "background",
      source: "subagentGrouping",
      label: "enrichParent.start",
      details: {
        standaloneCount: standalone.length,
        groupCount: subagentGroups.length,
        groups: subagentGroups.map((g) => ({
          groupId: g.groupId,
          childProviderThreadId: g.childProviderThreadId,
          status: g.status,
          completedAt: g.completedAt ?? null,
          entryCount: g.entries.length,
        })),
        parentCandidates: standalone
          .filter((e) => e.itemType === "collab_agent_tool_call")
          .map((e) => ({
            id: e.id,
            toolCallId: e.toolCallId ?? null,
            receiverThreadIds: e.receiverThreadIds ?? null,
            isBackgroundCommand: e.isBackgroundCommand ?? false,
          })),
      },
    });
  }

  const enrichedGroups = enrichSubagentGroupsWithControlMetadata(subagentGroups, standalone);

  // Build a lookup from childProviderThreadId → enriched group
  const groupByChildThreadId = new Map<string, SubagentGroup>();
  for (const group of enrichedGroups) {
    groupByChildThreadId.set(group.childProviderThreadId, group);
  }

  const preferredCodexParentIdByChildThreadId = new Map<string, string>();
  for (const entry of standalone) {
    if (entry.itemType !== "collab_agent_tool_call" || !isCodexSpawnCollabTool(entry.toolName)) {
      continue;
    }

    for (const childThreadId of entry.receiverThreadIds ?? []) {
      if (!preferredCodexParentIdByChildThreadId.has(childThreadId)) {
        preferredCodexParentIdByChildThreadId.set(childThreadId, entry.id);
      }
    }
  }

  const completionEntries: WorkLogEntry[] = [];

  const enrichedEntries = standalone.map((entry) => {
    if (entry.itemType !== "collab_agent_tool_call") {
      return entry;
    }

    const isCodexSpawnEntry = isCodexSpawnCollabTool(entry.toolName);

    // Claude: toolCallId IS the childProviderThreadId
    const claudeMatch = entry.toolCallId ? groupByChildThreadId.get(entry.toolCallId) : undefined;

    // Codex: receiverThreadIds contains childProviderThreadId(s)
    const codexMatches: SubagentGroup[] = [];
    if (!claudeMatch && entry.receiverThreadIds) {
      for (const threadId of entry.receiverThreadIds) {
        const preferredParentId = preferredCodexParentIdByChildThreadId.get(threadId);
        if (preferredParentId && preferredParentId !== entry.id) {
          continue;
        }

        const group = groupByChildThreadId.get(threadId);
        if (group) {
          codexMatches.push(group);
        }
      }
    }

    // For Codex multi-agent fan-out a single spawn call can target multiple receiver threads.
    // We attach the first matched group to the parent entry. Additional groups currently have
    // no parent to attach to — their child activities won't surface in the timeline. This is
    // acceptable for now since multi-child spawn is rare, but should be revisited if Codex
    // starts using fan-out more broadly.
    if (DEBUG_BACKGROUND_TASKS && codexMatches.length > 1) {
      debugLog({
        topic: "background",
        source: "subagentGrouping",
        label: "multi-child-spawn",
        details: {
          parentEntryId: entry.id,
          matchedChildCount: codexMatches.length,
          childThreadIds: codexMatches.map((g) => g.childProviderThreadId),
        },
      });
    }

    const matchedGroup = claudeMatch ?? codexMatches[0];
    if (!matchedGroup) {
      return entry;
    }

    const fallbackEntries =
      matchedGroup.entries.length <= SUBAGENT_FALLBACK_ENTRY_LIMIT
        ? matchedGroup.entries
        : matchedGroup.entries.slice(-SUBAGENT_FALLBACK_ENTRY_LIMIT);

    const isBackground = entry.isBackgroundCommand === true || isCodexSpawnEntry;
    const isTerminal = matchedGroup.status === "completed" || matchedGroup.status === "failed";

    const enrichedEntry: WorkLogEntry = Object.assign({}, entry, {
      subagentGroupMeta: {
        childProviderThreadId: matchedGroup.childProviderThreadId,
        status: matchedGroup.status,
        startedAt: matchedGroup.startedAt,
        completedAt: matchedGroup.completedAt,
        recordedActionCount: matchedGroup.recordedActionCount,
        fallbackEntries,
      },
      agentDescription: entry.agentDescription ?? matchedGroup.agentDescription,
      agentPrompt: entry.agentPrompt ?? matchedGroup.agentPrompt,
      agentType: entry.agentType ?? matchedGroup.agentType,
      agentModel: entry.agentModel ?? matchedGroup.agentModel,
    });
    if (isBackground) {
      enrichedEntry.isBackgroundCommand = true;
      enrichedEntry.backgroundLifecycleRole = "launch";
    }

    // Background agents that have completed get a separate completion entry in the timeline,
    // mirroring how background commands produce a completion row at the time they finish.
    if (isBackground && isTerminal && matchedGroup.completedAt) {
      const isFailed = matchedGroup.status === "failed";
      completionEntries.push({
        id: `${entry.id}:background-agent-completed`,
        createdAt: matchedGroup.completedAt,
        ...(matchedGroup.completedSequence !== undefined
          ? { sequence: matchedGroup.completedSequence }
          : {}),
        startedAt: matchedGroup.startedAt,
        completedAt: matchedGroup.completedAt,
        label: isFailed ? "Background agent failed" : "Background agent completed",
        tone: isFailed ? "error" : "tool",
        itemType: "collab_agent_tool_call",
        itemStatus: isFailed ? "failed" : "completed",
        toolName: entry.toolName,
        toolCallId: entry.toolCallId,
        activityKind: "task.completed",
        isBackgroundCommand: true,
        backgroundLifecycleRole: "completion",
        agentDescription: enrichedEntry.agentDescription,
        agentPrompt: enrichedEntry.agentPrompt,
        agentType: enrichedEntry.agentType,
        agentModel: enrichedEntry.agentModel,
        // Completion entries don't carry subagentGroupMeta — the child activities live on the
        // spawn (launch) entry. This entry is just a temporal marker in the timeline.
      });
    }

    return enrichedEntry;
  });

  if (DEBUG_BACKGROUND_TASKS) {
    const enrichedAgents = enrichedEntries.filter((e) => e.subagentGroupMeta);
    debugLog({
      topic: "background",
      source: "subagentGrouping",
      label: "enrichParent.result",
      details: {
        enrichedAgentCount: enrichedAgents.length,
        enrichedAgents: enrichedAgents.map((e) => ({
          id: e.id,
          isBackground: e.isBackgroundCommand ?? false,
          lifecycleRole: e.backgroundLifecycleRole ?? null,
          groupStatus: e.subagentGroupMeta?.status,
          groupCompletedAt: e.subagentGroupMeta?.completedAt ?? null,
        })),
        completionEntryCount: completionEntries.length,
        completionEntries: completionEntries.map((e) => ({
          id: e.id,
          createdAt: e.createdAt,
          itemStatus: e.itemStatus,
        })),
      },
    });
  }

  // Merge completion entries into the result at the correct chronological position.
  if (completionEntries.length === 0) {
    return enrichedEntries;
  }
  return [...enrichedEntries, ...completionEntries].toSorted((a, b) => {
    if (a.sequence !== undefined && b.sequence !== undefined && a.sequence !== b.sequence) {
      return a.sequence - b.sequence;
    }
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export function enrichSubagentGroupsWithControlMetadata(
  subagentGroups: ReadonlyArray<SubagentGroup>,
  standaloneEntries: ReadonlyArray<WorkLogEntry>,
): SubagentGroup[] {
  const metadataByChildThreadId = collectChildThreadMetadata(standaloneEntries, subagentGroups);

  return subagentGroups.map((group) => {
    const metadata = metadataByChildThreadId.get(group.childProviderThreadId);
    if (!metadata) {
      return group;
    }
    const shouldReplacePlaceholderLabel = isGenericSubagentLabel(group.label);
    return {
      ...group,
      label: shouldReplacePlaceholderLabel && metadata.label ? metadata.label : group.label,
      agentDescription: group.agentDescription ?? metadata.description,
      agentPrompt: group.agentPrompt ?? metadata.prompt,
      agentType: group.agentType ?? metadata.agentType,
      agentModel: group.agentModel ?? metadata.agentModel,
    };
  });
}

export function collectChildThreadMetadata(
  standaloneEntries: ReadonlyArray<
    Pick<
      WorkLogEntry,
      | "itemType"
      | "receiverThreadIds"
      | "agentDescription"
      | "agentPrompt"
      | "detail"
      | "agentType"
      | "agentModel"
    >
  >,
  subagentGroups: ReadonlyArray<
    Pick<
      SubagentGroup,
      | "childProviderThreadId"
      | "label"
      | "agentDescription"
      | "agentPrompt"
      | "agentType"
      | "agentModel"
    >
  >,
): Map<
  string,
  {
    label?: string;
    description?: string;
    prompt?: string;
    agentType?: string;
    agentModel?: string;
  }
> {
  const metadataByChildThreadId = new Map<
    string,
    {
      label?: string;
      description?: string;
      prompt?: string;
      agentType?: string;
      agentModel?: string;
    }
  >();

  for (const group of subagentGroups) {
    metadataByChildThreadId.set(group.childProviderThreadId, {
      ...(group.label ? { label: group.label } : {}),
      ...(group.agentDescription ? { description: group.agentDescription } : {}),
      ...(group.agentPrompt ? { prompt: group.agentPrompt } : {}),
      ...(group.agentType ? { agentType: group.agentType } : {}),
      ...(group.agentModel ? { agentModel: group.agentModel } : {}),
    });
  }

  for (const entry of standaloneEntries) {
    if (entry.itemType !== "collab_agent_tool_call") {
      continue;
    }

    for (const childThreadId of entry.receiverThreadIds ?? []) {
      const current = metadataByChildThreadId.get(childThreadId) ?? {};
      const description = current.description ?? entry.agentDescription;
      const prompt = current.prompt ?? entry.agentPrompt;
      const label = current.label ?? description ?? entry.detail;
      const agentType = current.agentType ?? entry.agentType;
      const agentModel = current.agentModel ?? entry.agentModel;
      metadataByChildThreadId.set(childThreadId, {
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
        ...(prompt ? { prompt } : {}),
        ...(agentType ? { agentType } : {}),
        ...(agentModel ? { agentModel } : {}),
      });
    }
  }

  return metadataByChildThreadId;
}

export function enrichVisibleCollabControlEntriesWithTargetMetadata(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const standaloneEntries = entries.filter((entry) => !entry.childThreadAttribution);
  const metadataByChildThreadId = collectChildThreadMetadata(standaloneEntries, []);

  return entries.map((entry) => {
    if (entry.itemType !== "collab_agent_tool_call") {
      return entry;
    }

    const [firstReceiverThreadId] = entry.receiverThreadIds ?? [];
    if (!firstReceiverThreadId) {
      return entry;
    }

    const metadata = metadataByChildThreadId.get(firstReceiverThreadId);
    if (!metadata) {
      return entry;
    }

    return {
      ...entry,
      agentDescription: entry.agentDescription ?? metadata.label,
      agentPrompt: entry.agentPrompt ?? metadata.prompt,
      agentType: entry.agentType ?? metadata.agentType,
      agentModel: entry.agentModel ?? metadata.agentModel,
    };
  });
}
