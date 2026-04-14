import {
  type OrchestrationDiffFileChange,
  type OrchestrationToolInlineDiff,
  isToolLifecycleItemType,
  TurnId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
} from "@forgetools/contracts";
import { asRecord, truncateDetail } from "@forgetools/shared/narrowing";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../../checkpointing/Diffs.ts";
import { classifyToolDiffPaths, filterUnifiedDiffByPaths } from "../../toolDiffPaths.ts";
import { logBackgroundDebug } from "../../../provider/adapterUtils.ts";

import {
  toTurnId,
  sameId,
  isApprovalRequestType,
  requestKindFromCanonicalRequestType,
  buildContextWindowActivityPayload,
  extractChildThreadAttribution,
  extractBackgroundDebugChildThread,
  extractBackgroundDebugSource,
  extractBackgroundDebugProcessId,
  extractBackgroundDebugCommandPreview,
  pathsOverlap,
} from "./helpers.ts";

function summarizeInlineDiffFiles(files: ReadonlyArray<OrchestrationDiffFileChange>): {
  additions?: number;
  deletions?: number;
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

function buildExactInlineDiffFromUnifiedDiff(input: {
  readonly inlineDiff: OrchestrationToolInlineDiff;
  readonly unifiedDiff: string;
  readonly workspaceRoot: string;
}): OrchestrationToolInlineDiff {
  const patchFiles = parseTurnDiffFilesFromUnifiedDiff(input.unifiedDiff).map((file) => ({
    path: file.path,
    additions: file.additions,
    deletions: file.deletions,
  }));
  const metadataByPath = new Map<string, OrchestrationDiffFileChange>();
  for (const file of input.inlineDiff.files) {
    const normalizedPath = classifyToolDiffPaths({
      workspaceRoot: input.workspaceRoot,
      filePaths: [file.path],
      ...(process.env.WSL_DISTRO_NAME ? { wslDistroName: process.env.WSL_DISTRO_NAME } : {}),
    }).repoRelativePaths[0];
    if (!normalizedPath) {
      continue;
    }
    const existing = metadataByPath.get(normalizedPath);
    metadataByPath.set(normalizedPath, {
      path: normalizedPath,
      kind: file.kind ?? existing?.kind,
      additions: file.additions ?? existing?.additions,
      deletions: file.deletions ?? existing?.deletions,
    });
  }
  const files = patchFiles.map((file) => {
    const metadata = metadataByPath.get(file.path);
    if (metadata?.kind) {
      return {
        path: file.path,
        kind: metadata.kind,
        additions: file.additions,
        deletions: file.deletions,
      } satisfies OrchestrationDiffFileChange;
    }
    return {
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    } satisfies OrchestrationDiffFileChange;
  });
  const stats = summarizeInlineDiffFiles(files);
  return {
    availability: "exact_patch",
    files,
    unifiedDiff: input.unifiedDiff,
    ...(stats.additions !== undefined ? { additions: stats.additions } : {}),
    ...(stats.deletions !== undefined ? { deletions: stats.deletions } : {}),
  };
}

export function extractActivityInlineDiff(
  activity: OrchestrationThreadActivity,
): OrchestrationToolInlineDiff | undefined {
  const payload = asRecord(activity.payload);
  const inlineDiff = asRecord(payload?.inlineDiff);
  if (!inlineDiff || !Array.isArray(inlineDiff.files)) {
    return undefined;
  }
  if (inlineDiff.availability !== "exact_patch" && inlineDiff.availability !== "summary_only") {
    return undefined;
  }
  const files = inlineDiff.files
    .map((file) => asRecord(file))
    .filter((file): file is Record<string, unknown> => file !== undefined)
    .flatMap((file) => {
      const path = typeof file.path === "string" ? file.path : undefined;
      if (!path) {
        return [];
      }
      return [
        {
          path,
          ...(typeof file.kind === "string" ? { kind: file.kind } : {}),
          ...(typeof file.additions === "number" ? { additions: file.additions } : {}),
          ...(typeof file.deletions === "number" ? { deletions: file.deletions } : {}),
        },
      ];
    });
  if (files.length === 0) {
    return undefined;
  }
  return {
    availability: inlineDiff.availability,
    files,
    ...(typeof inlineDiff.unifiedDiff === "string" ? { unifiedDiff: inlineDiff.unifiedDiff } : {}),
    ...(typeof inlineDiff.additions === "number" ? { additions: inlineDiff.additions } : {}),
    ...(typeof inlineDiff.deletions === "number" ? { deletions: inlineDiff.deletions } : {}),
  };
}

function extractFileChangeActivityIdentity(
  activity: OrchestrationThreadActivity,
  filePaths: ReadonlyArray<string>,
):
  | {
      readonly key: string;
      readonly source: "item" | "paths";
    }
  | undefined {
  const payload = asRecord(activity.payload);
  if (typeof payload?.itemId === "string" && payload.itemId.length > 0) {
    return {
      key: `item:${payload.itemId}`,
      source: "item",
    };
  }
  const sortedPaths = [...filePaths].toSorted();
  return sortedPaths.length > 0
    ? {
        key: `files:${sortedPaths.join("|")}`,
        source: "paths",
      }
    : undefined;
}

function activityIsSummaryOnlyFileChange(
  activity: OrchestrationThreadActivity,
  turnId: TurnId,
  workspaceRoot: string,
):
  | {
      activity: OrchestrationThreadActivity;
      identity: string;
      identitySource: "item" | "paths";
      inlineDiff: OrchestrationToolInlineDiff;
      paths: ReadonlyArray<string>;
    }
  | undefined {
  if (!sameId(activity.turnId, turnId)) {
    return undefined;
  }
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return undefined;
  }
  const payload = asRecord(activity.payload);
  if (payload?.itemType !== "file_change") {
    return undefined;
  }
  const inlineDiff = extractActivityInlineDiff(activity);
  if (!inlineDiff) {
    return undefined;
  }
  if (inlineDiff.availability !== "summary_only") {
    return undefined;
  }
  const paths = classifyToolDiffPaths({
    workspaceRoot,
    filePaths: inlineDiff.files.map((file) => file.path),
    ...(process.env.WSL_DISTRO_NAME ? { wslDistroName: process.env.WSL_DISTRO_NAME } : {}),
  }).repoRelativePaths;
  if (paths.length === 0) {
    return undefined;
  }
  const identity = extractFileChangeActivityIdentity(activity, paths);
  if (!identity) {
    return undefined;
  }
  return {
    activity,
    identity: identity.key,
    identitySource: identity.source,
    inlineDiff,
    paths,
  };
}

export function upgradeActivitiesFromExactTurnDiff(input: {
  readonly activitiesToUpgrade: ReadonlyArray<OrchestrationThreadActivity>;
  readonly activityContext: ReadonlyArray<OrchestrationThreadActivity>;
  readonly turnId: TurnId;
  readonly workspaceRoot: string;
  readonly unifiedDiff: string;
}): OrchestrationThreadActivity[] {
  const candidates = input.activityContext
    .map((activity) => activityIsSummaryOnlyFileChange(activity, input.turnId, input.workspaceRoot))
    .filter(
      (
        candidate,
      ): candidate is {
        activity: OrchestrationThreadActivity;
        identity: string;
        identitySource: "item" | "paths";
        inlineDiff: OrchestrationToolInlineDiff;
        paths: string[];
      } => candidate !== undefined,
    );
  if (candidates.length === 0) {
    return [...input.activitiesToUpgrade];
  }

  const groups = new Map<
    string,
    {
      identitySource: "item" | "paths";
      paths: ReadonlyArray<string>;
      activityIds: Set<string>;
    }
  >();
  for (const candidate of candidates) {
    const existing = groups.get(candidate.identity);
    if (!existing) {
      groups.set(candidate.identity, {
        identitySource: candidate.identitySource,
        paths: candidate.paths,
        activityIds: new Set([candidate.activity.id]),
      });
      continue;
    }
    groups.set(candidate.identity, {
      identitySource: existing.identitySource,
      paths: [...new Set([...existing.paths, ...candidate.paths])].toSorted(),
      activityIds: new Set([...existing.activityIds, candidate.activity.id]),
    });
  }

  const safeIdentities = new Set<string>();
  if (groups.size === 1) {
    const [[identity, group] = []] = groups.entries();
    if (identity && group && !(group.identitySource === "paths" && group.activityIds.size > 1)) {
      safeIdentities.add(identity);
    }
  } else {
    for (const [identity, group] of groups.entries()) {
      if (group.identitySource === "paths" && group.activityIds.size > 1) {
        continue;
      }
      const overlaps = [...groups.entries()].some(
        ([otherIdentity, otherGroup]) =>
          otherIdentity !== identity && pathsOverlap(group.paths, otherGroup.paths),
      );
      if (!overlaps) {
        safeIdentities.add(identity);
      }
    }
  }

  return input.activitiesToUpgrade.map((activity) => {
    const candidate = activityIsSummaryOnlyFileChange(activity, input.turnId, input.workspaceRoot);
    if (!candidate || !safeIdentities.has(candidate.identity)) {
      return activity;
    }
    const filteredDiff = filterUnifiedDiffByPaths({
      diff: input.unifiedDiff,
      allowedPaths: candidate.paths,
      workspaceRoot: input.workspaceRoot,
      ...(process.env.WSL_DISTRO_NAME ? { wslDistroName: process.env.WSL_DISTRO_NAME } : {}),
    });
    if (!filteredDiff || filteredDiff.trim().length === 0) {
      return activity;
    }
    const payload = asRecord(activity.payload);
    if (!payload) {
      return activity;
    }
    return {
      ...activity,
      payload: {
        ...payload,
        inlineDiff: buildExactInlineDiffFromUnifiedDiff({
          inlineDiff: candidate.inlineDiff,
          unifiedDiff: filteredDiff,
          workspaceRoot: input.workspaceRoot,
        }),
      },
    };
  });
}

export function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
  options?: {
    readonly inlineDiff?: OrchestrationToolInlineDiff;
  },
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();
  switch (event.type) {
    case "request.opened": {
      if (isApprovalRequestType(event.payload.requestType)) {
        const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
        return [
          {
            id: event.eventId,
            createdAt: event.createdAt,
            tone: "approval",
            kind: "approval.requested",
            summary:
              requestKind === "command"
                ? "Command approval requested"
                : requestKind === "file-read"
                  ? "File-read approval requested"
                  : requestKind === "file-change"
                    ? "File-change approval requested"
                    : "Approval requested",
            payload: {
              ...(event.requestId ? { requestId: event.requestId } : {}),
              ...(requestKind ? { requestKind } : {}),
              requestType: event.payload.requestType,
              ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            },
            turnId: toTurnId(event.turnId) ?? null,
            ...maybeSequence,
          },
        ];
      }
      if (event.payload.requestType === "permission_approval") {
        return [
          {
            id: event.eventId,
            createdAt: event.createdAt,
            tone: "approval",
            kind: "approval.requested",
            summary: "Permission request",
            payload: {
              ...(event.requestId ? { requestId: event.requestId } : {}),
              requestType: event.payload.requestType,
              ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            },
            turnId: toTurnId(event.turnId) ?? null,
            ...maybeSequence,
          },
        ];
      }
      if (event.payload.requestType === "mcp_elicitation") {
        return [
          {
            id: event.eventId,
            createdAt: event.createdAt,
            tone: "info",
            kind: "user-input.requested",
            summary: "MCP input requested",
            payload: {
              ...(event.requestId ? { requestId: event.requestId } : {}),
              requestType: event.payload.requestType,
              ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            },
            turnId: toTurnId(event.turnId) ?? null,
            ...maybeSequence,
          },
        ];
      }
      return [];
    }

    case "request.resolved": {
      if (isApprovalRequestType(event.payload.requestType)) {
        const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
        return [
          {
            id: event.eventId,
            createdAt: event.createdAt,
            tone: "approval",
            kind: "approval.resolved",
            summary: "Approval resolved",
            payload: {
              ...(event.requestId ? { requestId: event.requestId } : {}),
              ...(requestKind ? { requestKind } : {}),
              requestType: event.payload.requestType,
              ...(event.payload.decision ? { decision: event.payload.decision } : {}),
            },
            turnId: toTurnId(event.turnId) ?? null,
            ...maybeSequence,
          },
        ];
      }
      if (event.payload.requestType === "permission_approval") {
        return [
          {
            id: event.eventId,
            createdAt: event.createdAt,
            tone: "approval",
            kind: "approval.resolved",
            summary: "Permission request resolved",
            payload: {
              ...(event.requestId ? { requestId: event.requestId } : {}),
              requestType: event.payload.requestType,
              ...(event.payload.resolution ? { resolution: event.payload.resolution } : {}),
            },
            turnId: toTurnId(event.turnId) ?? null,
            ...maybeSequence,
          },
        ];
      }
      if (event.payload.requestType === "mcp_elicitation") {
        return [
          {
            id: event.eventId,
            createdAt: event.createdAt,
            tone: "info",
            kind: "user-input.resolved",
            summary: "MCP input submitted",
            payload: {
              ...(event.requestId ? { requestId: event.requestId } : {}),
              requestType: event.payload.requestType,
              ...(event.payload.resolution ? { resolution: event.payload.resolution } : {}),
            },
            turnId: toTurnId(event.turnId) ?? null,
            ...maybeSequence,
          },
        ];
      }
      return [];
    }

    case "runtime.error": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(event.payload.message),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          summary: "Runtime warning",
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.plan.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      const taskStartedChildAttr = extractChildThreadAttribution(event.payload);
      const taskStartedSourceItemType = event.payload.sourceItemType;
      const taskStartedSourceToolName = event.payload.sourceToolName;
      logBackgroundDebug("ingestion", "runtime.task.started", {
        threadId: event.threadId,
        turnId: event.turnId ?? null,
        taskId: event.payload.taskId,
        taskType: event.payload.taskType ?? null,
        childThreadAttribution: extractBackgroundDebugChildThread(event.payload) ?? null,
      });
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            taskStartedSourceItemType === "dynamic_tool_call" && taskStartedSourceToolName
              ? `${taskStartedSourceToolName} started`
              : event.payload.taskType === "plan"
                ? "Plan task started"
                : event.payload.taskType
                  ? `${event.payload.taskType} task started`
                  : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(taskStartedSourceItemType ? { itemType: taskStartedSourceItemType } : {}),
            ...(taskStartedSourceToolName ? { toolName: taskStartedSourceToolName } : {}),
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...(event.payload.prompt ? { prompt: event.payload.prompt } : {}),
            ...(event.payload.workflowName ? { workflowName: event.payload.workflowName } : {}),
            ...(event.payload.sourceDetail
              ? { sourceDetail: truncateDetail(event.payload.sourceDetail) }
              : {}),
            ...(event.payload.sourceTimeoutMs !== undefined
              ? { sourceTimeoutMs: event.payload.sourceTimeoutMs }
              : {}),
            ...(event.payload.sourcePersistent !== undefined
              ? { sourcePersistent: event.payload.sourcePersistent }
              : {}),
            ...(taskStartedChildAttr ? { childThreadAttribution: taskStartedChildAttr } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      const taskProgressChildAttr = extractChildThreadAttribution(event.payload);
      const taskProgressSourceItemType = event.payload.sourceItemType;
      const taskProgressSourceToolName = event.payload.sourceToolName;
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.progress",
          summary:
            taskProgressSourceItemType === "dynamic_tool_call" && taskProgressSourceToolName
              ? `${taskProgressSourceToolName} progress`
              : "Reasoning update",
          payload: {
            taskId: event.payload.taskId,
            ...(taskProgressSourceItemType ? { itemType: taskProgressSourceItemType } : {}),
            ...(taskProgressSourceToolName ? { toolName: taskProgressSourceToolName } : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            detail: truncateDetail(event.payload.summary ?? event.payload.description),
            ...(event.payload.summary ? { summary: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...(event.payload.sourceDetail
              ? { sourceDetail: truncateDetail(event.payload.sourceDetail) }
              : {}),
            ...(event.payload.sourceTimeoutMs !== undefined
              ? { sourceTimeoutMs: event.payload.sourceTimeoutMs }
              : {}),
            ...(event.payload.sourcePersistent !== undefined
              ? { sourcePersistent: event.payload.sourcePersistent }
              : {}),
            ...(taskProgressChildAttr ? { childThreadAttribution: taskProgressChildAttr } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      const taskCompletedChildAttr = extractChildThreadAttribution(event.payload);
      const taskCompletedSourceItemType = event.payload.sourceItemType;
      const taskCompletedSourceToolName = event.payload.sourceToolName;
      logBackgroundDebug("ingestion", "runtime.task.completed", {
        threadId: event.threadId,
        turnId: event.turnId ?? null,
        taskId: event.payload.taskId,
        status: event.payload.status,
        childThreadAttribution: extractBackgroundDebugChildThread(event.payload) ?? null,
      });
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            taskCompletedSourceItemType === "dynamic_tool_call" && taskCompletedSourceToolName
              ? event.payload.status === "failed"
                ? `${taskCompletedSourceToolName} failed`
                : event.payload.status === "stopped"
                  ? `${taskCompletedSourceToolName} stopped`
                  : `${taskCompletedSourceToolName} completed`
              : event.payload.status === "failed"
                ? "Task failed"
                : event.payload.status === "stopped"
                  ? "Task stopped"
                  : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(taskCompletedSourceItemType ? { itemType: taskCompletedSourceItemType } : {}),
            ...(taskCompletedSourceToolName ? { toolName: taskCompletedSourceToolName } : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.summary ? { detail: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...(event.payload.outputFile ? { outputFile: event.payload.outputFile } : {}),
            ...(event.payload.sourceDetail
              ? { sourceDetail: truncateDetail(event.payload.sourceDetail) }
              : {}),
            ...(event.payload.sourceTimeoutMs !== undefined
              ? { sourceTimeoutMs: event.payload.sourceTimeoutMs }
              : {}),
            ...(event.payload.sourcePersistent !== undefined
              ? { sourcePersistent: event.payload.sourcePersistent }
              : {}),
            ...(taskCompletedChildAttr ? { childThreadAttribution: taskCompletedChildAttr } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.updated": {
      const taskUpdatedChildAttr = extractChildThreadAttribution(event.payload);
      const patchPayload = asRecord(event.payload.patch);
      const patchStatus =
        typeof patchPayload?.status === "string" ? patchPayload.status : undefined;
      const taskUpdatedSourceItemType = event.payload.sourceItemType;
      const taskUpdatedSourceToolName = event.payload.sourceToolName;
      logBackgroundDebug("ingestion", "runtime.task.updated", {
        threadId: event.threadId,
        turnId: event.turnId ?? null,
        taskId: event.payload.taskId,
        patchStatus: patchStatus ?? null,
        childThreadAttribution: extractBackgroundDebugChildThread(event.payload) ?? null,
      });
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: patchStatus === "failed" || patchStatus === "killed" ? "error" : "info",
          kind: "task.updated",
          summary:
            taskUpdatedSourceItemType === "dynamic_tool_call" && taskUpdatedSourceToolName
              ? patchStatus === "failed"
                ? `${taskUpdatedSourceToolName} failed`
                : patchStatus === "killed"
                  ? `${taskUpdatedSourceToolName} killed`
                  : patchStatus === "completed"
                    ? `${taskUpdatedSourceToolName} completed`
                    : `${taskUpdatedSourceToolName} updated`
              : "Task updated",
          payload: {
            taskId: event.payload.taskId,
            patch: event.payload.patch,
            ...(taskUpdatedSourceItemType ? { itemType: taskUpdatedSourceItemType } : {}),
            ...(taskUpdatedSourceToolName ? { toolName: taskUpdatedSourceToolName } : {}),
            ...(event.payload.sourceDetail
              ? { sourceDetail: truncateDetail(event.payload.sourceDetail) }
              : {}),
            ...(event.payload.sourceTimeoutMs !== undefined
              ? { sourceTimeoutMs: event.payload.sourceTimeoutMs }
              : {}),
            ...(event.payload.sourcePersistent !== undefined
              ? { sourcePersistent: event.payload.sourcePersistent }
              : {}),
            ...(taskUpdatedChildAttr ? { childThreadAttribution: taskUpdatedChildAttr } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary: "Context compacted",
          payload: {
            state: event.payload.state,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.token-usage.updated": {
      const payload = buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.progress": {
      // Access payload fields safely - the schema is being updated by another agent
      // but the payload will have: toolUseId?, toolName?, summary?, elapsedSeconds?
      const payload = event.payload as Record<string, unknown>;
      const message =
        typeof payload.message === "string"
          ? payload.message
          : typeof payload.summary === "string"
            ? payload.summary
            : undefined;
      const toolName = typeof payload.toolName === "string" ? payload.toolName : undefined;
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool" as const,
          kind: "tool.progress",
          summary: message ?? (toolName ? `${toolName} in progress` : "Tool in progress"),
          payload: {
            ...(typeof payload.toolUseId === "string" ? { toolCallId: payload.toolUseId } : {}),
            ...(toolName ? { toolName } : {}),
            ...(message ? { detail: truncateDetail(message) } : {}),
            ...(typeof payload.elapsedSeconds === "number"
              ? { elapsedSeconds: payload.elapsedSeconds }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.summary": {
      const payload = event.payload as Record<string, unknown>;
      const summary = typeof payload.summary === "string" ? payload.summary : undefined;
      if (!summary) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool" as const,
          kind: "tool.summary",
          summary,
          payload: {
            summary,
            ...(Array.isArray(payload.toolUseIds) ? { toolUseIds: payload.toolUseIds } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "hook.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "hook.started",
          summary: `Hook started: ${event.payload.hookName}`,
          payload: event.payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "hook.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.outcome === "error" ? "error" : "tool",
          kind: "hook.completed",
          summary: event.payload.outcome === "error" ? "Hook failed" : "Hook completed",
          payload: event.payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "mcp.status.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "mcp.status.updated",
          summary: "MCP server status updated",
          payload: event.payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "model.rerouted": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "model.rerouted",
          summary: `Model rerouted to ${event.payload.toModel}`,
          payload: event.payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "content.delta": {
      if (event.payload.streamKind !== "command_output") {
        return [];
      }
      const contentDeltaChildAttr = extractChildThreadAttribution(event.payload);
      logBackgroundDebug("ingestion", "runtime.content.delta", {
        threadId: event.threadId,
        turnId: event.turnId ?? null,
        itemId: event.itemId ?? null,
        streamKind: event.payload.streamKind,
        deltaLength: event.payload.delta.length,
        childThreadAttribution: extractBackgroundDebugChildThread(event.payload) ?? null,
      });
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.output.delta",
          summary: "Command output updated",
          payload: {
            ...(event.itemId ? { itemId: event.itemId } : {}),
            streamKind: event.payload.streamKind,
            delta: event.payload.delta,
            ...(contentDeltaChildAttr ? { childThreadAttribution: contentDeltaChildAttr } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "terminal.interaction": {
      const terminalInteractionChildAttr = extractChildThreadAttribution(event.payload);
      logBackgroundDebug("ingestion", "runtime.terminal.interaction", {
        threadId: event.threadId,
        turnId: event.turnId ?? null,
        itemId: event.itemId ?? null,
        processId: event.payload.processId,
        stdinLength: event.payload.stdin.length,
        childThreadAttribution: extractBackgroundDebugChildThread(event.payload) ?? null,
      });
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.terminal.interaction",
          summary:
            event.payload.stdin.length === 0
              ? "Background terminal waited"
              : "Background terminal updated",
          payload: {
            ...(event.itemId ? { itemId: event.itemId } : {}),
            processId: event.payload.processId,
            stdin: event.payload.stdin,
            ...(terminalInteractionChildAttr
              ? { childThreadAttribution: terminalInteractionChildAttr }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      const itemUpdatedToolName = (event.payload as Record<string, unknown>).toolName;
      const itemUpdatedChildAttr = extractChildThreadAttribution(event.payload);
      if (
        event.payload.itemType === "command_execution" ||
        event.payload.itemType === "collab_agent_tool_call"
      ) {
        logBackgroundDebug("ingestion", "runtime.item.updated", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          itemType: event.payload.itemType,
          itemId: event.itemId ?? null,
          source: extractBackgroundDebugSource(event.payload.data) ?? null,
          processId: extractBackgroundDebugProcessId(event.payload.data) ?? null,
          status: event.payload.status ?? null,
          toolName: typeof itemUpdatedToolName === "string" ? itemUpdatedToolName : null,
          childThreadAttribution: extractBackgroundDebugChildThread(event.payload) ?? null,
        });
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: {
            itemType: event.payload.itemType,
            ...(event.itemId ? { itemId: event.itemId } : {}),
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
            ...(options?.inlineDiff ? { inlineDiff: options.inlineDiff } : {}),
            ...(typeof itemUpdatedToolName === "string" ? { toolName: itemUpdatedToolName } : {}),
            ...(itemUpdatedChildAttr ? { childThreadAttribution: itemUpdatedChildAttr } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.completed": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      const itemCompletedToolName = (event.payload as Record<string, unknown>).toolName;
      const itemCompletedChildAttr = extractChildThreadAttribution(event.payload);
      if (
        event.payload.itemType === "command_execution" ||
        event.payload.itemType === "collab_agent_tool_call"
      ) {
        const projectedData = event.payload.data;
        logBackgroundDebug("ingestion", "runtime.item.completed", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          itemType: event.payload.itemType,
          itemId: event.itemId ?? null,
          source: extractBackgroundDebugSource(event.payload.data) ?? null,
          processId: extractBackgroundDebugProcessId(event.payload.data) ?? null,
          commandPreview: extractBackgroundDebugCommandPreview(event.payload.data) ?? null,
          status: event.payload.status ?? null,
          toolName: typeof itemCompletedToolName === "string" ? itemCompletedToolName : null,
          childThreadAttribution: extractBackgroundDebugChildThread(event.payload) ?? null,
          projectedPayload: {
            hasData: projectedData !== undefined,
            source: extractBackgroundDebugSource(projectedData) ?? null,
            processId: extractBackgroundDebugProcessId(projectedData) ?? null,
          },
        });
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: event.payload.title ?? "Tool",
          payload: {
            itemType: event.payload.itemType,
            ...(event.itemId ? { itemId: event.itemId } : {}),
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
            ...(options?.inlineDiff ? { inlineDiff: options.inlineDiff } : {}),
            ...(typeof itemCompletedToolName === "string"
              ? { toolName: itemCompletedToolName }
              : {}),
            ...(itemCompletedChildAttr ? { childThreadAttribution: itemCompletedChildAttr } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.started": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      const itemStartedToolName = (event.payload as Record<string, unknown>).toolName;
      const itemStartedChildAttr = extractChildThreadAttribution(event.payload);
      const includeStartedData =
        event.payload.itemType === "command_execution" ||
        event.payload.itemType === "collab_agent_tool_call";
      if (
        event.payload.itemType === "command_execution" ||
        event.payload.itemType === "collab_agent_tool_call"
      ) {
        logBackgroundDebug("ingestion", "runtime.item.started", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          itemType: event.payload.itemType,
          itemId: event.itemId ?? null,
          source: extractBackgroundDebugSource(event.payload.data) ?? null,
          processId: extractBackgroundDebugProcessId(event.payload.data) ?? null,
          commandPreview: extractBackgroundDebugCommandPreview(event.payload.data) ?? null,
          status: event.payload.status ?? null,
          toolName: typeof itemStartedToolName === "string" ? itemStartedToolName : null,
          childThreadAttribution: extractBackgroundDebugChildThread(event.payload) ?? null,
          projectedPayload: {
            hasData: includeStartedData && event.payload.data !== undefined,
            source:
              includeStartedData && event.payload.data !== undefined
                ? (extractBackgroundDebugSource(event.payload.data) ?? null)
                : null,
            processId:
              includeStartedData && event.payload.data !== undefined
                ? (extractBackgroundDebugProcessId(event.payload.data) ?? null)
                : null,
          },
        });
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.itemId ? { itemId: event.itemId } : {}),
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(includeStartedData && event.payload.data !== undefined
              ? { data: event.payload.data }
              : {}),
            ...(typeof itemStartedToolName === "string" ? { toolName: itemStartedToolName } : {}),
            ...(itemStartedChildAttr ? { childThreadAttribution: itemStartedChildAttr } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  return [];
}

/**
 * Determines whether a runtime event represents a semantic boundary in the
 * assistant's text output stream. Boundary events cause any buffered assistant
 * text to be flushed as a complete message before the event is processed.
 *
 * Non-boundary events (telemetry, progress, status updates) are processed
 * without interrupting the text buffer, even if they produce activities.
 *
 * DEFAULT IS NON-BOUNDARY. New event types must be explicitly added as
 * boundary cases if they represent a break in the assistant's text flow.
 * This prevents telemetry or informational events from accidentally splitting
 * assistant messages.
 */
export function isAssistantTextBoundary(event: ProviderRuntimeEvent): boolean {
  switch (event.type) {
    // Tool lifecycle — tool execution creates a visible break in assistant text.
    // Must check isToolLifecycleItemType to avoid triggering on assistant_message,
    // reasoning, plan, etc. which have their own explicit flush paths.
    case "item.started":
    case "item.updated":
    case "item.completed":
      return isToolLifecycleItemType(event.payload.itemType);

    // Approval/permission/input dialogs interrupt the text flow — the user
    // needs to see preceding text before interacting with the dialog.
    case "request.opened":
    case "user-input.requested":
      return true;

    // Command output interleaves with assistant text in the conversation.
    // Other stream kinds (assistant_text, reasoning_text, etc.) are the
    // buffered content itself and must NOT trigger a flush.
    case "content.delta":
      return event.payload.streamKind === "command_output";

    // Terminal interactions appear inline between text chunks.
    case "terminal.interaction":
      return true;

    // Hook execution is a visible inline boundary.
    case "hook.started":
    case "hook.completed":
      return true;

    // Errors interrupt the text flow — preceding text should be visible.
    case "runtime.error":
      return true;

    // --- Non-boundary events below ---
    // These produce activities but should NOT flush the assistant text buffer.

    // Telemetry / status — the primary bug triggers.
    case "thread.token-usage.updated":
    case "task.started":
    case "task.progress":
    case "task.completed":
    case "task.updated":
    case "tool.progress":
    case "tool.summary":
    case "turn.plan.updated":
    case "model.rerouted":
    case "runtime.warning":
    case "mcp.status.updated":
      return false;

    // Resolution events — the subsequent tool lifecycle event is the boundary.
    case "request.resolved":
    case "user-input.resolved":
      return false;

    // Session/thread/turn lifecycle — handled by explicit flush paths
    // (assistantCompletion, turn.completed, session.exited).
    case "session.started":
    case "session.configured":
    case "session.state.changed":
    case "session.exited":
    case "thread.started":
    case "thread.state.changed":
    case "thread.metadata.updated":
    case "turn.started":
    case "turn.completed":
    case "turn.aborted":
    case "turn.proposed.delta":
    case "turn.proposed.completed":
    case "turn.diff.updated":
      return false;

    // Informational / infrastructure events.
    case "hook.progress":
    case "auth.status":
    case "account.updated":
    case "account.rate-limits.updated":
    case "mcp.oauth.completed":
    case "config.warning":
    case "deprecation.notice":
    case "files.persisted":
      return false;

    // Realtime (voice) events — separate rendering path.
    case "thread.realtime.started":
    case "thread.realtime.item-added":
    case "thread.realtime.audio.delta":
    case "thread.realtime.error":
    case "thread.realtime.closed":
      return false;

    default: {
      // Exhaustiveness guard — TypeScript will error here if a new event type
      // is added to ProviderRuntimeEventType without being handled above.
      const _exhaustive: never = event;
      return false;
    }
  }
}
