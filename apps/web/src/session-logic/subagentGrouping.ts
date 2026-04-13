import { EventId, type OrchestrationThreadActivity } from "@forgetools/contracts";

import { asArray, asRecord, asTrimmedString } from "@forgetools/shared/narrowing";

import type { DerivedWorkLogEntry, SubagentGroup, WorkLogEntry } from "./types";
import { COMPLETED_SUBAGENT_FALLBACK_ENTRY_LIMIT } from "./types";

export function isCodexControlCollabTool(toolName: string | null | undefined): boolean {
  return toolName === "sendInput" || toolName === "wait";
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

export function isVisibleCollabControlWorkEntry(
  entry: Pick<DerivedWorkLogEntry, "itemType" | "toolName">,
): boolean {
  // Claude emits user-visible Agent launch rows through the same lifecycle collapse path as Codex
  // spawn/wait controls. If we only whitelist Codex names here, the empty start payload and richer
  // completion payload split into duplicate inline rows instead of one collapsed control entry.
  return (
    entry.itemType === "collab_agent_tool_call" &&
    isVisibleCollabControlTool(entry.toolName ?? null)
  );
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
  if (payload?.itemType === "collab_agent_tool_call") {
    return !isVisibleCollabControlTool(extractCollabControlToolName(payload));
  }
  return payload?.itemType !== "command_execution";
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
      group.completedAt =
        group.completedAt && group.completedAt > entry.createdAt
          ? group.completedAt
          : entry.createdAt;
      if (entry.sequence !== undefined) {
        group.completedSequence =
          group.completedSequence !== undefined
            ? Math.max(group.completedSequence, entry.sequence)
            : entry.sequence;
      }
      const completedStatus =
        entry.itemStatus === "failed" || entry.itemStatus === "declined" || entry.tone === "error"
          ? "failed"
          : "completed";
      group.status = group.status === "failed" ? "failed" : completedStatus;
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

export function synthesizeCodexSubagentLifecycleActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThreadActivity[] {
  const startsByChildKey = new Set<string>();
  const completionsByChildKey = new Set<string>();
  const knownChildThreadIds = new Set<string>();
  for (const activity of activities) {
    const payload = asRecord(activity.payload);
    const childAttr = asRecord(payload?.childThreadAttribution);
    const childProviderThreadId = asTrimmedString(childAttr?.childProviderThreadId);
    if (childProviderThreadId) {
      knownChildThreadIds.add(childProviderThreadId);
    }

    if (activity.kind === "task.started") {
      const taskId = asTrimmedString(childAttr?.taskId);
      if (taskId && childProviderThreadId) {
        startsByChildKey.add(`${taskId}\u001f${childProviderThreadId}`);
      }
      continue;
    }

    if (activity.kind !== "task.completed") {
      continue;
    }
    const taskId = asTrimmedString(childAttr?.taskId);
    if (taskId && childProviderThreadId) {
      completionsByChildKey.add(`${taskId}\u001f${childProviderThreadId}`);
    }
  }

  const syntheticActivities: OrchestrationThreadActivity[] = [];
  for (const activity of activities) {
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

      const completionKey = `${taskId}\u001f${childProviderThreadId}`;
      if (completionsByChildKey.has(completionKey)) {
        continue;
      }
      if (isCodexControlCollabTool(toolName) && !knownChildThreadIds.has(childProviderThreadId)) {
        continue;
      }

      const agentState = asRecord(agentsStates?.[childProviderThreadId]);
      // Codex marks the collab tool call itself as completed as soon as the channel operation
      // finishes. For spawn_agent that usually means "child thread created", not "child task
      // finished". The app-server tests explicitly assert that spawn_agent can be completed while
      // the child agent state is still pendingInit/running, so we only synthesize a subagent
      // completion from the per-child agentsStates entry once that child reaches a terminal state.
      const normalizedStatus = normalizeCodexCollabAgentTerminalStatus(
        asTrimmedString(agentState?.status),
      );
      if (normalizedStatus === "running") {
        continue;
      }

      completionsByChildKey.add(completionKey);
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
      activity.kind === "task.completed"
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

export function retainCompletedSubagentEntryTail(group: SubagentGroup): SubagentGroup {
  // Keep a small local tail so completed history rows can still render some activity immediately
  // if the lazy RPC feed is slow or unavailable, without duplicating the entire child transcript
  // into every timeline projection.
  if (group.entries.length <= COMPLETED_SUBAGENT_FALLBACK_ENTRY_LIMIT) {
    return group;
  }

  return {
    ...group,
    entries: group.entries.slice(-COMPLETED_SUBAGENT_FALLBACK_ENTRY_LIMIT),
  };
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
      const label = current.label ?? description ?? prompt ?? entry.detail;
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

export function compactSubagentGroups(
  subagentGroups: ReadonlyArray<SubagentGroup>,
): SubagentGroup[] {
  return subagentGroups.map((group) => ({
    ...group,
    entries: [],
  }));
}
