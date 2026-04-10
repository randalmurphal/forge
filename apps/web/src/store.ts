import {
  type ForgeEvent,
  type InteractiveRequest,
  type OrchestrationAgentDiffSummary,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type ProjectId,
  type ProviderKind,
  SessionArchivedPayload,
  SessionCancelledPayload,
  SessionCompletedPayload,
  SessionFailedPayload,
  SessionMessageSentPayload,
  SessionStatusChangedPayload,
  SessionTurnCompletedPayload,
  SessionTurnRestartedPayload,
  SessionTurnStartedPayload,
  ThreadArchivedPayload,
  ThreadCreatedPayload,
  ThreadForkedPayload,
  ThreadMessageSentPayload,
  ThreadId,
  type TurnId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationCheckpointSummary,
  type OrchestrationThread,
  type OrchestrationSessionStatus,
} from "@forgetools/contracts";
import { Schema } from "effect";
import { resolveModelSlugForProvider } from "@forgetools/shared/model";
import { resolveThreadSpawnWorkspace } from "@forgetools/shared/threadWorkspace";
import { create } from "zustand";
import {
  findLatestProposedPlan,
  hasActionableProposedPlan,
  isLatestTurnSettled,
  derivePendingApprovals,
  derivePendingUserInputs,
} from "./session-logic";
import {
  type ChatMessage,
  type DesignArtifact,
  type DesignPendingOptions,
  type Project,
  type SidebarThreadSummary,
  type Thread,
} from "./types";
import { newMessageId } from "./lib/utils";

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  sidebarThreadsById: Record<string, SidebarThreadSummary>;
  threadIdsByProjectId: Record<string, ThreadId[]>;
  bootstrapComplete: boolean;
}

const initialState: AppState = {
  projects: [],
  threads: [],
  sidebarThreadsById: {},
  threadIdsByProjectId: {},
  bootstrapComplete: false,
};
const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_CHECKPOINTS = 500;
const MAX_THREAD_PROPOSED_PLANS = 200;
const MAX_THREAD_ACTIVITIES = 500;
const EMPTY_THREAD_IDS: ThreadId[] = [];
const EMPTY_THREADS: Thread[] = [];
const isThreadCreatedPayload = Schema.is(ThreadCreatedPayload);
const isThreadForkedPayload = Schema.is(ThreadForkedPayload);
const isThreadArchivedPayload = Schema.is(ThreadArchivedPayload);
const isSessionArchivedPayload = Schema.is(SessionArchivedPayload);
const isThreadMessageSentPayload = Schema.is(ThreadMessageSentPayload);
const isSessionMessageSentPayload = Schema.is(SessionMessageSentPayload);
const isSessionTurnStartedPayload = Schema.is(SessionTurnStartedPayload);
const isSessionTurnCompletedPayload = Schema.is(SessionTurnCompletedPayload);
const isSessionTurnRestartedPayload = Schema.is(SessionTurnRestartedPayload);
const isSessionStatusChangedPayload = Schema.is(SessionStatusChangedPayload);
const isSessionCompletedPayload = Schema.is(SessionCompletedPayload);
const isSessionFailedPayload = Schema.is(SessionFailedPayload);
const isSessionCancelledPayload = Schema.is(SessionCancelledPayload);

// ── Pure helpers ──────────────────────────────────────────────────────

function updateThread(
  threads: Thread[],
  threadId: ThreadId,
  updater: (t: Thread) => Thread,
): Thread[] {
  let changed = false;
  const next = threads.map((t) => {
    if (t.id !== threadId) return t;
    const updated = updater(t);
    if (updated !== t) changed = true;
    return updated;
  });
  return changed ? next : threads;
}

function updateProject(
  projects: Project[],
  projectId: Project["id"],
  updater: (project: Project) => Project,
): Project[] {
  let changed = false;
  const next = projects.map((project) => {
    if (project.id !== projectId) {
      return project;
    }
    const updated = updater(project);
    if (updated !== project) {
      changed = true;
    }
    return updated;
  });
  return changed ? next : projects;
}

function normalizeModelSelection<T extends { provider: "codex" | "claudeAgent"; model: string }>(
  selection: T,
): T {
  return {
    ...selection,
    model: resolveModelSlugForProvider(selection.provider, selection.model),
  };
}

function mapProjectScripts(scripts: ReadonlyArray<Project["scripts"][number]>): Project["scripts"] {
  return scripts.map((script) => ({ ...script }));
}

function mapSession(session: OrchestrationSession): Thread["session"] {
  return {
    provider: toLegacyProvider(session.providerName),
    status: toLegacySessionStatus(session.status),
    orchestrationStatus: session.status,
    activeTurnId: session.activeTurnId ?? undefined,
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    ...(session.lastError ? { lastError: session.lastError } : {}),
  };
}

function mapMessageAttachments(
  attachments: OrchestrationMessage["attachments"] | undefined,
): ChatMessage["attachments"] | undefined {
  return attachments?.map((attachment) => ({
    type: "image" as const,
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    previewUrl: toAttachmentPreviewUrl(attachmentPreviewRoutePath(attachment.id)),
  }));
}

function mapMessage(message: OrchestrationMessage): ChatMessage {
  const attachments = mapMessageAttachments(message.attachments);

  return {
    id: message.id,
    role: message.role,
    text: message.text,
    turnId: message.turnId,
    createdAt: message.createdAt,
    streaming: message.streaming,
    ...(message.attribution !== undefined ? { attribution: message.attribution } : {}),
    ...(message.streaming ? {} : { completedAt: message.updatedAt }),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

function mapProposedPlan(proposedPlan: OrchestrationProposedPlan): Thread["proposedPlans"][number] {
  return {
    id: proposedPlan.id,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
  };
}

function mapTurnDiffSummary(
  checkpoint: OrchestrationCheckpointSummary,
): Thread["turnDiffSummaries"][number] {
  return {
    turnId: checkpoint.turnId,
    completedAt: checkpoint.completedAt,
    status: checkpoint.status,
    provenance: "workspace",
    assistantMessageId: checkpoint.assistantMessageId ?? undefined,
    checkpointTurnCount: checkpoint.checkpointTurnCount,
    checkpointRef: checkpoint.checkpointRef,
    files: checkpoint.files.map((file) => ({ ...file })),
  };
}

function mapAgentDiffSummary(
  agentDiff: OrchestrationAgentDiffSummary,
): NonNullable<Thread["agentDiffSummaries"]>[number] {
  return {
    turnId: agentDiff.turnId,
    completedAt: agentDiff.completedAt,
    provenance: "agent",
    coverage: agentDiff.coverage,
    source: agentDiff.source,
    assistantMessageId: agentDiff.assistantMessageId ?? undefined,
    files: agentDiff.files.map((file) => ({ ...file })),
  };
}

function toDesignPendingOptions(input: {
  requestId: string;
  payload: unknown;
}): DesignPendingOptions | null {
  const payload =
    input.payload && typeof input.payload === "object"
      ? (input.payload as Record<string, unknown>)
      : null;
  if (payload?.type !== "design-option" || typeof payload.prompt !== "string") {
    return null;
  }

  const options = Array.isArray(payload.options)
    ? payload.options
        .map<DesignPendingOptions["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") {
            return null;
          }
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.id !== "string" ||
            typeof optionRecord.title !== "string" ||
            typeof optionRecord.description !== "string" ||
            typeof optionRecord.artifactId !== "string" ||
            typeof optionRecord.artifactPath !== "string"
          ) {
            return null;
          }
          return {
            id: optionRecord.id,
            title: optionRecord.title,
            description: optionRecord.description,
            artifactId: optionRecord.artifactId,
            artifactPath: optionRecord.artifactPath,
          };
        })
        .filter((option): option is DesignPendingOptions["options"][number] => option !== null)
    : [];

  if (options.length === 0) {
    return null;
  }

  return {
    requestId: input.requestId,
    prompt: payload.prompt,
    options,
    chosenOptionId: null,
  };
}

function resolvePendingDesignOptions(
  threadId: Thread["id"],
  pendingRequests: ReadonlyArray<InteractiveRequest>,
): DesignPendingOptions | null {
  let latestPendingRequest: InteractiveRequest | null = null;

  for (const request of pendingRequests) {
    if (
      request.threadId !== threadId ||
      request.type !== "design-option" ||
      request.status !== "pending"
    ) {
      continue;
    }
    if (latestPendingRequest === null || request.createdAt > latestPendingRequest.createdAt) {
      latestPendingRequest = request;
    }
  }

  if (latestPendingRequest === null) {
    return null;
  }

  return toDesignPendingOptions({
    requestId: latestPendingRequest.id,
    payload: latestPendingRequest.payload,
  });
}

function hasPendingDesignChoice(thread: Pick<Thread, "designPendingOptions">): boolean {
  return (
    thread.designPendingOptions !== null && thread.designPendingOptions.chosenOptionId === null
  );
}

function mapThread(
  thread: OrchestrationThread,
  pendingRequests: ReadonlyArray<InteractiveRequest>,
): Thread {
  const spawnWorkspace = resolveThreadSpawnWorkspace(thread);
  return {
    id: thread.id,
    codexThreadId: null,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId ?? null,
    forkedFromThreadId: thread.forkedFromThreadId ?? null,
    phaseRunId: thread.phaseRunId ?? null,
    title: thread.title,
    modelSelection: normalizeModelSelection(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    workflowId: thread.workflowId ?? null,
    currentPhaseId: thread.currentPhaseId ?? null,
    discussionId: thread.discussionId ?? null,
    role: thread.role ?? null,
    childThreadIds: [...(thread.childThreadIds ?? [])],
    session: thread.session ? mapSession(thread.session) : null,
    messages: thread.messages.map(mapMessage),
    proposedPlans: thread.proposedPlans.map(mapProposedPlan),
    error: thread.session?.lastError ?? null,
    createdAt: thread.createdAt,
    pinnedAt: thread.pinnedAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    pendingSourceProposedPlan: thread.latestTurn?.sourceProposedPlan,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    spawnBranch: spawnWorkspace.branch,
    spawnWorktreePath: spawnWorkspace.worktreePath,
    designArtifacts: [],
    designPendingOptions: resolvePendingDesignOptions(thread.id, pendingRequests),
    agentDiffSummaries: (thread.agentDiffs ?? []).map(mapAgentDiffSummary),
    turnDiffSummaries: thread.checkpoints.map(mapTurnDiffSummary),
    activities: thread.activities.map((activity) => ({ ...activity })),
    ...(thread.spawnMode !== undefined ? { spawnMode: thread.spawnMode } : {}),
  };
}

function mapProject(project: OrchestrationReadModel["projects"][number]): Project {
  return {
    id: project.id,
    name: project.title,
    cwd: project.workspaceRoot,
    defaultModelSelection: project.defaultModelSelection
      ? normalizeModelSelection(project.defaultModelSelection)
      : null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    scripts: mapProjectScripts(project.scripts),
  };
}

function getLatestUserMessageAt(
  messages: ReadonlyArray<Thread["messages"][number]>,
): string | null {
  let latestUserMessageAt: string | null = null;

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    if (latestUserMessageAt === null || message.createdAt > latestUserMessageAt) {
      latestUserMessageAt = message.createdAt;
    }
  }

  return latestUserMessageAt;
}

/**
 * Computes the timestamp that should drive sidebar sort order.
 * Only advances for user-relevant events:
 * - User sent a message (latest user message timestamp)
 * - Agent turn actually settled — uses isLatestTurnSettled to confirm the session
 *   is no longer running, since latestTurn.completedAt gets set mid-turn by
 *   intermediate assistant message completions (between tool calls) in both
 *   Codex and Claude providers
 * - Agent needs user attention (pending approvals, pending user input,
 *   pending design choice, or plan ready)
 *
 * Falls back to updatedAt → createdAt for threads with no qualifying events.
 */
function getLastSortableActivityAt(thread: Thread): string | null {
  const candidates: string[] = [];

  const latestUserMsg = getLatestUserMessageAt(thread.messages);
  if (latestUserMsg !== null) {
    candidates.push(latestUserMsg);
  }

  if (thread.latestTurn?.completedAt && isLatestTurnSettled(thread.latestTurn, thread.session)) {
    candidates.push(thread.latestTurn.completedAt);
  }

  const needsAttention =
    derivePendingApprovals(thread.activities).length > 0 ||
    derivePendingUserInputs(thread.activities).length > 0 ||
    hasPendingDesignChoice(thread) ||
    hasActionableProposedPlan(
      findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null),
    );
  if (needsAttention && thread.updatedAt) {
    candidates.push(thread.updatedAt);
  }

  if (candidates.length === 0) {
    return thread.updatedAt ?? thread.createdAt ?? null;
  }

  return candidates.reduce((a, b) => (a > b ? a : b));
}

function buildSidebarThreadSummary(thread: Thread): SidebarThreadSummary {
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId ?? null,
    phaseRunId: thread.phaseRunId ?? null,
    title: thread.title,
    interactionMode: thread.interactionMode,
    workflowId: thread.workflowId ?? null,
    currentPhaseId: thread.currentPhaseId ?? null,
    discussionId: thread.discussionId ?? null,
    role: thread.role ?? null,
    childThreadIds: [...(thread.childThreadIds ?? [])],
    session: thread.session,
    createdAt: thread.createdAt,
    pinnedAt: thread.pinnedAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    spawnBranch: thread.spawnBranch ?? null,
    spawnWorktreePath: thread.spawnWorktreePath ?? null,
    latestUserMessageAt: getLatestUserMessageAt(thread.messages),
    lastSortableActivityAt: getLastSortableActivityAt(thread),
    hasPendingApprovals: derivePendingApprovals(thread.activities).length > 0,
    hasPendingUserInput: derivePendingUserInputs(thread.activities).length > 0,
    hasPendingDesignChoice: hasPendingDesignChoice(thread),
    hasActionableProposedPlan: hasActionableProposedPlan(
      findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null),
    ),
    ...(thread.spawnMode !== undefined ? { spawnMode: thread.spawnMode } : {}),
  };
}

function sidebarThreadSummariesEqual(
  left: SidebarThreadSummary | undefined,
  right: SidebarThreadSummary,
): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.parentThreadId === right.parentThreadId &&
    left.phaseRunId === right.phaseRunId &&
    left.title === right.title &&
    left.interactionMode === right.interactionMode &&
    left.workflowId === right.workflowId &&
    left.currentPhaseId === right.currentPhaseId &&
    (left.discussionId ?? null) === (right.discussionId ?? null) &&
    left.role === right.role &&
    (left.childThreadIds ?? []).length === (right.childThreadIds ?? []).length &&
    (left.childThreadIds ?? []).every(
      (threadId, index) => threadId === (right.childThreadIds ?? [])[index],
    ) &&
    left.session === right.session &&
    left.createdAt === right.createdAt &&
    left.pinnedAt === right.pinnedAt &&
    left.archivedAt === right.archivedAt &&
    left.updatedAt === right.updatedAt &&
    left.latestTurn === right.latestTurn &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.spawnMode === right.spawnMode &&
    left.spawnBranch === right.spawnBranch &&
    left.spawnWorktreePath === right.spawnWorktreePath &&
    left.latestUserMessageAt === right.latestUserMessageAt &&
    left.lastSortableActivityAt === right.lastSortableActivityAt &&
    left.hasPendingApprovals === right.hasPendingApprovals &&
    left.hasPendingUserInput === right.hasPendingUserInput &&
    left.hasPendingDesignChoice === right.hasPendingDesignChoice &&
    left.hasActionableProposedPlan === right.hasActionableProposedPlan
  );
}

function appendThreadIdByProjectId(
  threadIdsByProjectId: Record<string, ThreadId[]>,
  projectId: ProjectId,
  threadId: ThreadId,
): Record<string, ThreadId[]> {
  const existingThreadIds = threadIdsByProjectId[projectId] ?? EMPTY_THREAD_IDS;
  if (existingThreadIds.includes(threadId)) {
    return threadIdsByProjectId;
  }
  return {
    ...threadIdsByProjectId,
    [projectId]: [...existingThreadIds, threadId],
  };
}

function removeThreadIdByProjectId(
  threadIdsByProjectId: Record<string, ThreadId[]>,
  projectId: ProjectId,
  threadId: ThreadId,
): Record<string, ThreadId[]> {
  const existingThreadIds = threadIdsByProjectId[projectId] ?? EMPTY_THREAD_IDS;
  if (!existingThreadIds.includes(threadId)) {
    return threadIdsByProjectId;
  }
  const nextThreadIds = existingThreadIds.filter(
    (existingThreadId) => existingThreadId !== threadId,
  );
  if (nextThreadIds.length === existingThreadIds.length) {
    return threadIdsByProjectId;
  }
  if (nextThreadIds.length === 0) {
    const nextThreadIdsByProjectId = { ...threadIdsByProjectId };
    delete nextThreadIdsByProjectId[projectId];
    return nextThreadIdsByProjectId;
  }
  return {
    ...threadIdsByProjectId,
    [projectId]: nextThreadIds,
  };
}

function buildThreadIdsByProjectId(threads: ReadonlyArray<Thread>): Record<string, ThreadId[]> {
  const threadIdsByProjectId: Record<string, ThreadId[]> = {};
  for (const thread of threads) {
    const existingThreadIds = threadIdsByProjectId[thread.projectId] ?? EMPTY_THREAD_IDS;
    threadIdsByProjectId[thread.projectId] = [...existingThreadIds, thread.id];
  }
  return threadIdsByProjectId;
}

function buildSidebarThreadsById(
  threads: ReadonlyArray<Thread>,
): Record<string, SidebarThreadSummary> {
  return Object.fromEntries(
    threads.map((thread) => [thread.id, buildSidebarThreadSummary(thread)]),
  );
}

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") {
    return "error" as const;
  }
  if (status === "missing") {
    return "interrupted" as const;
  }
  return "completed" as const;
}

function compareActivities(
  left: Thread["activities"][number],
  right: Thread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function buildLatestTurn(params: {
  previous: Thread["latestTurn"];
  turnId: NonNullable<Thread["latestTurn"]>["turnId"];
  state: NonNullable<Thread["latestTurn"]>["state"];
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"];
  sourceProposedPlan?: Thread["pendingSourceProposedPlan"];
}): NonNullable<Thread["latestTurn"]> {
  const resolvedPlan =
    params.previous?.turnId === params.turnId
      ? params.previous.sourceProposedPlan
      : params.sourceProposedPlan;
  return {
    turnId: params.turnId,
    state: params.state,
    requestedAt: params.requestedAt,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    assistantMessageId: params.assistantMessageId,
    ...(resolvedPlan ? { sourceProposedPlan: resolvedPlan } : {}),
  };
}

function patchThreadSession(
  thread: Thread,
  patch: Partial<NonNullable<Thread["session"]>>,
  nextError?: string | null,
): Thread {
  if (thread.session === null) {
    return thread;
  }

  return {
    ...thread,
    session: {
      ...thread.session,
      ...patch,
    },
    ...(nextError !== undefined ? { error: nextError } : {}),
  };
}

function rebindTurnDiffSummariesForAssistantMessage(
  turnDiffSummaries: ReadonlyArray<Thread["turnDiffSummaries"][number]>,
  turnId: Thread["turnDiffSummaries"][number]["turnId"],
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"],
): Thread["turnDiffSummaries"] {
  let changed = false;
  const nextSummaries = turnDiffSummaries.map((summary) => {
    if (summary.turnId !== turnId || summary.assistantMessageId === assistantMessageId) {
      return summary;
    }
    changed = true;
    return {
      ...summary,
      assistantMessageId: assistantMessageId ?? undefined,
    };
  });
  return changed ? nextSummaries : [...turnDiffSummaries];
}

function rebindAgentDiffSummariesForAssistantMessage(
  agentDiffSummaries: ReadonlyArray<NonNullable<Thread["agentDiffSummaries"]>[number]>,
  turnId: TurnId,
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"],
): NonNullable<Thread["agentDiffSummaries"]> {
  let changed = false;
  const nextSummaries = agentDiffSummaries.map((summary) => {
    if (summary.turnId !== turnId || summary.assistantMessageId === assistantMessageId) {
      return summary;
    }
    changed = true;
    return {
      ...summary,
      assistantMessageId: assistantMessageId ?? undefined,
    };
  });
  return changed ? nextSummaries : [...agentDiffSummaries];
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<ChatMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ChatMessage[] {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (
      message.turnId !== undefined &&
      message.turnId !== null &&
      retainedTurnIds.has(message.turnId)
    ) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<Thread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Thread["activities"] {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<Thread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Thread["proposedPlans"] {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

function toLegacyProvider(providerName: string | null): ProviderKind {
  if (providerName === "codex" || providerName === "claudeAgent") {
    return providerName;
  }
  return "codex";
}

function toOrchestrationSessionStatusFromForgeStatus(
  status: Extract<ForgeEvent, { type: "thread.status-changed" }>["payload"]["status"],
): OrchestrationSessionStatus {
  switch (status) {
    case "created":
      return "starting";
    case "running":
      return "running";
    case "needs-attention":
    case "paused":
      return "interrupted";
    case "completed":
      return "idle";
    case "failed":
      return "error";
    case "cancelled":
      return "stopped";
  }

  return "starting";
}

function resolveWsHttpOrigin(): string {
  if (typeof window === "undefined") return "";
  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;
  if (!wsCandidate) return window.location.origin;
  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return window.location.origin;
  }
}

function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/")) {
    return `${resolveWsHttpOrigin()}${rawUrl}`;
  }
  return rawUrl;
}

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

function updateThreadState(
  state: AppState,
  threadId: ThreadId,
  updater: (thread: Thread) => Thread,
): AppState {
  let updatedThread: Thread | null = null;
  const threads = updateThread(state.threads, threadId, (thread) => {
    const nextThread = updater(thread);
    if (nextThread !== thread) {
      updatedThread = nextThread;
    }
    return nextThread;
  });
  if (threads === state.threads || updatedThread === null) {
    return state;
  }

  const nextSummary = buildSidebarThreadSummary(updatedThread);
  const previousSummary = state.sidebarThreadsById[threadId];
  const sidebarThreadsById = sidebarThreadSummariesEqual(previousSummary, nextSummary)
    ? state.sidebarThreadsById
    : {
        ...state.sidebarThreadsById,
        [threadId]: nextSummary,
      };

  if (sidebarThreadsById === state.sidebarThreadsById) {
    return {
      ...state,
      threads,
    };
  }

  return {
    ...state,
    threads,
    sidebarThreadsById,
  };
}

function updateThreadByDesignRequestId(
  state: AppState,
  requestId: string,
  updater: (thread: Thread) => Thread,
): AppState {
  const thread = state.threads.find((entry) => entry.designPendingOptions?.requestId === requestId);
  if (!thread) {
    return state;
  }
  return updateThreadState(state, thread.id, updater);
}

// ── Pure state transition functions ────────────────────────────────────

export function syncServerReadModel(state: AppState, readModel: OrchestrationReadModel): AppState {
  const projects = readModel.projects
    .filter((project) => project.deletedAt === null)
    .map(mapProject);
  const threads = readModel.threads
    .filter((thread) => thread.deletedAt === null)
    .map((thread) => mapThread(thread, readModel.pendingRequests));
  const sidebarThreadsById = buildSidebarThreadsById(threads);
  const threadIdsByProjectId = buildThreadIdsByProjectId(threads);
  return {
    ...state,
    projects,
    threads,
    sidebarThreadsById,
    threadIdsByProjectId,
    bootstrapComplete: true,
  };
}

export function applyOrchestrationEvent(state: AppState, event: ForgeEvent): AppState {
  switch (event.type) {
    case "project.created": {
      const existingIndex = state.projects.findIndex(
        (project) =>
          project.id === event.payload.projectId || project.cwd === event.payload.workspaceRoot,
      );
      const nextProject = mapProject({
        id: event.payload.projectId,
        title: event.payload.title,
        workspaceRoot: event.payload.workspaceRoot,
        defaultModelSelection: event.payload.defaultModelSelection,
        scripts: event.payload.scripts,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
        deletedAt: null,
      });
      const projects =
        existingIndex >= 0
          ? state.projects.map((project, index) =>
              index === existingIndex ? nextProject : project,
            )
          : [...state.projects, nextProject];
      return { ...state, projects };
    }

    case "project.meta-updated": {
      const projects = updateProject(state.projects, event.payload.projectId, (project) => ({
        ...project,
        ...(event.payload.title !== undefined ? { name: event.payload.title } : {}),
        ...(event.payload.workspaceRoot !== undefined ? { cwd: event.payload.workspaceRoot } : {}),
        ...(event.payload.defaultModelSelection !== undefined
          ? {
              defaultModelSelection: event.payload.defaultModelSelection
                ? normalizeModelSelection(event.payload.defaultModelSelection)
                : null,
            }
          : {}),
        ...(event.payload.scripts !== undefined
          ? { scripts: mapProjectScripts(event.payload.scripts) }
          : {}),
        updatedAt: event.payload.updatedAt,
      }));
      return projects === state.projects ? state : { ...state, projects };
    }

    case "project.deleted": {
      const projects = state.projects.filter((project) => project.id !== event.payload.projectId);
      return projects.length === state.projects.length ? state : { ...state, projects };
    }

    case "thread.created": {
      if (!isThreadCreatedPayload(event.payload)) {
        return state;
      }
      const payload = event.payload;
      const existing = state.threads.find((thread) => thread.id === event.payload.threadId);
      const stagedThreadPayload = event.payload as Partial<
        Pick<
          OrchestrationThread,
          | "parentThreadId"
          | "phaseRunId"
          | "workflowId"
          | "currentPhaseId"
          | "discussionId"
          | "role"
          | "childThreadIds"
        >
      >;
      const parentThreadId: OrchestrationThread["parentThreadId"] =
        stagedThreadPayload.parentThreadId ?? null;
      const phaseRunId: OrchestrationThread["phaseRunId"] = stagedThreadPayload.phaseRunId ?? null;
      const workflowId: OrchestrationThread["workflowId"] = stagedThreadPayload.workflowId ?? null;
      const currentPhaseId: OrchestrationThread["currentPhaseId"] =
        stagedThreadPayload.currentPhaseId ?? null;
      const discussionId: OrchestrationThread["discussionId"] =
        stagedThreadPayload.discussionId ?? null;
      const role: OrchestrationThread["role"] = stagedThreadPayload.role ?? null;
      const childThreadIds: OrchestrationThread["childThreadIds"] =
        stagedThreadPayload.childThreadIds ?? [];
      const spawnMode: OrchestrationThread["spawnMode"] =
        payload.spawnMode ??
        ((
          payload.spawnWorktreePath !== undefined ? payload.spawnWorktreePath : payload.worktreePath
        )
          ? "worktree"
          : "local");
      const spawnBranch: OrchestrationThread["spawnBranch"] =
        payload.spawnBranch !== undefined ? payload.spawnBranch : payload.branch;
      const spawnWorktreePath: OrchestrationThread["spawnWorktreePath"] =
        payload.spawnWorktreePath !== undefined ? payload.spawnWorktreePath : payload.worktreePath;
      const nextThread = mapThread(
        {
          id: payload.threadId,
          projectId: payload.projectId,
          title: payload.title,
          modelSelection: payload.modelSelection,
          runtimeMode: payload.runtimeMode,
          interactionMode: payload.interactionMode,
          branch: payload.branch,
          worktreePath: payload.worktreePath,
          spawnMode,
          latestTurn: null,
          createdAt: payload.createdAt,
          updatedAt: payload.updatedAt,
          pinnedAt: null,
          archivedAt: null,
          deletedAt: null,
          spawnBranch,
          spawnWorktreePath,
          parentThreadId,
          phaseRunId,
          workflowId,
          currentPhaseId,
          discussionId: discussionId,
          role,
          childThreadIds,
          bootstrapStatus: null,
          forkedFromThreadId: payload.forkedFromThreadId ?? null,
          messages: [],
          proposedPlans: [],
          activities: [],
          agentDiffs: [],
          checkpoints: [],
          session: null,
        },
        [],
      );
      let threads = existing
        ? state.threads.map((thread) => (thread.id === nextThread.id ? nextThread : thread))
        : [...state.threads, nextThread];
      let updatedSidebarThreadsById = state.sidebarThreadsById;

      // If this child thread has a parent, add it to the parent's childThreadIds.
      if (parentThreadId !== null) {
        threads = threads.map((thread) =>
          thread.id === parentThreadId && !(thread.childThreadIds ?? []).includes(nextThread.id)
            ? { ...thread, childThreadIds: [...(thread.childThreadIds ?? []), nextThread.id] }
            : thread,
        );
        const updatedParent = threads.find((t) => t.id === parentThreadId);
        if (updatedParent) {
          const parentSummary = buildSidebarThreadSummary(updatedParent);
          updatedSidebarThreadsById = {
            ...updatedSidebarThreadsById,
            [parentThreadId]: parentSummary,
          };
        }
      }

      const nextSummary = buildSidebarThreadSummary(nextThread);
      const previousSummary = updatedSidebarThreadsById[nextThread.id];
      const sidebarThreadsById = sidebarThreadSummariesEqual(previousSummary, nextSummary)
        ? updatedSidebarThreadsById
        : {
            ...updatedSidebarThreadsById,
            [nextThread.id]: nextSummary,
          };
      const nextThreadIdsByProjectId =
        existing !== undefined && existing.projectId !== nextThread.projectId
          ? removeThreadIdByProjectId(state.threadIdsByProjectId, existing.projectId, existing.id)
          : state.threadIdsByProjectId;
      const threadIdsByProjectId = appendThreadIdByProjectId(
        nextThreadIdsByProjectId,
        nextThread.projectId,
        nextThread.id,
      );
      return {
        ...state,
        threads,
        sidebarThreadsById,
        threadIdsByProjectId,
      };
    }

    case "thread.deleted": {
      const threads = state.threads.filter((thread) => thread.id !== event.payload.threadId);
      if (threads.length === state.threads.length) {
        return state;
      }
      const deletedThread = state.threads.find((thread) => thread.id === event.payload.threadId);
      const sidebarThreadsById = { ...state.sidebarThreadsById };
      delete sidebarThreadsById[event.payload.threadId];
      const threadIdsByProjectId = deletedThread
        ? removeThreadIdByProjectId(
            state.threadIdsByProjectId,
            deletedThread.projectId,
            deletedThread.id,
          )
        : state.threadIdsByProjectId;
      return {
        ...state,
        threads,
        sidebarThreadsById,
        threadIdsByProjectId,
      };
    }

    case "thread.archived": {
      if (!isThreadArchivedPayload(event.payload) && !isSessionArchivedPayload(event.payload)) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: event.payload.archivedAt,
        updatedAt: isThreadArchivedPayload(event.payload)
          ? event.payload.updatedAt
          : event.payload.archivedAt,
      }));
    }

    case "thread.unarchived": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: null,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.pinned": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        pinnedAt: event.payload.pinnedAt,
      }));
    }

    case "thread.unpinned": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        pinnedAt: null,
      }));
    }

    case "thread.meta-updated": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: normalizeModelSelection(event.payload.modelSelection) }
          : {}),
        ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
        ...(event.payload.worktreePath !== undefined
          ? { worktreePath: event.payload.worktreePath }
          : {}),
      }));
    }

    case "thread.runtime-mode-set": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        runtimeMode: event.payload.runtimeMode,
      }));
    }

    case "thread.interaction-mode-set": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        interactionMode: event.payload.interactionMode,
      }));
    }

    case "thread.turn-start-requested": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: normalizeModelSelection(event.payload.modelSelection) }
          : {}),
        runtimeMode: event.payload.runtimeMode,
        interactionMode: event.payload.interactionMode,
        pendingSourceProposedPlan: event.payload.sourceProposedPlan,
      }));
    }

    case "thread.turn-interrupt-requested": {
      if (event.payload.turnId === undefined) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const latestTurn = thread.latestTurn;
        if (latestTurn === null || latestTurn.turnId !== event.payload.turnId) {
          return thread;
        }
        return {
          ...thread,
          latestTurn: buildLatestTurn({
            previous: latestTurn,
            turnId: event.payload.turnId,
            state: "interrupted",
            requestedAt: latestTurn.requestedAt,
            startedAt: latestTurn.startedAt ?? event.payload.createdAt,
            completedAt: latestTurn.completedAt ?? event.payload.createdAt,
            assistantMessageId: latestTurn.assistantMessageId,
          }),
        };
      });
    }

    case "thread.message-sent": {
      if (
        !isThreadMessageSentPayload(event.payload) &&
        !isSessionMessageSentPayload(event.payload)
      ) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const messageUpdatedAt = isThreadMessageSentPayload(event.payload)
          ? event.payload.updatedAt
          : event.payload.createdAt;
        const attachments =
          isThreadMessageSentPayload(event.payload) && event.payload.attachments !== undefined
            ? mapMessageAttachments(event.payload.attachments)
            : undefined;
        const message: ChatMessage = {
          id: event.payload.messageId,
          role: event.payload.role as ChatMessage["role"],
          text: isThreadMessageSentPayload(event.payload)
            ? event.payload.text
            : event.payload.content,
          turnId: event.payload.turnId,
          createdAt: event.payload.createdAt,
          streaming: event.payload.streaming,
          ...(event.payload.streaming ? {} : { completedAt: messageUpdatedAt }),
          ...(attachments !== undefined ? { attachments } : {}),
          ...(isThreadMessageSentPayload(event.payload) && event.payload.attribution !== undefined
            ? { attribution: event.payload.attribution }
            : {}),
        };
        const existingMessage = thread.messages.find((entry) => entry.id === message.id);
        const messages = existingMessage
          ? thread.messages.map((entry) =>
              entry.id !== message.id
                ? entry
                : {
                    ...entry,
                    text: message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                    streaming: message.streaming,
                    ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
                    ...(message.streaming
                      ? entry.completedAt !== undefined
                        ? { completedAt: entry.completedAt }
                        : {}
                      : message.completedAt !== undefined
                        ? { completedAt: message.completedAt }
                        : {}),
                    ...(message.attachments !== undefined
                      ? { attachments: message.attachments }
                      : {}),
                    ...(message.attribution !== undefined
                      ? { attribution: message.attribution }
                      : {}),
                  },
            )
          : [...thread.messages, message];
        const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);
        const turnDiffSummaries =
          event.payload.role === "assistant" && event.payload.turnId !== null
            ? rebindTurnDiffSummariesForAssistantMessage(
                thread.turnDiffSummaries,
                event.payload.turnId,
                event.payload.messageId,
              )
            : thread.turnDiffSummaries;
        const agentDiffSummaries =
          event.payload.role === "assistant" &&
          event.payload.turnId !== null &&
          thread.agentDiffSummaries !== undefined
            ? rebindAgentDiffSummariesForAssistantMessage(
                thread.agentDiffSummaries,
                event.payload.turnId,
                event.payload.messageId,
              )
            : thread.agentDiffSummaries;
        const latestTurn: Thread["latestTurn"] =
          event.payload.role === "assistant" &&
          event.payload.turnId !== null &&
          (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.turnId,
                state: event.payload.streaming
                  ? "running"
                  : thread.latestTurn?.state === "interrupted"
                    ? "interrupted"
                    : thread.latestTurn?.state === "error"
                      ? "error"
                      : "completed",
                requestedAt:
                  thread.latestTurn?.turnId === event.payload.turnId
                    ? thread.latestTurn.requestedAt
                    : event.payload.createdAt,
                startedAt:
                  thread.latestTurn?.turnId === event.payload.turnId
                    ? (thread.latestTurn.startedAt ?? event.payload.createdAt)
                    : event.payload.createdAt,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
                completedAt: event.payload.streaming
                  ? thread.latestTurn?.turnId === event.payload.turnId
                    ? (thread.latestTurn.completedAt ?? null)
                    : null
                  : messageUpdatedAt,
                assistantMessageId: event.payload.messageId,
              })
            : thread.latestTurn;
        return {
          ...thread,
          messages: cappedMessages,
          turnDiffSummaries,
          ...(agentDiffSummaries ? { agentDiffSummaries } : {}),
          latestTurn,
        };
      });
    }

    case "thread.turn-started": {
      if (!isSessionTurnStartedPayload(event.payload)) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...patchThreadSession(thread, {
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: event.payload.turnId,
          updatedAt: event.payload.startedAt,
        }),
        latestTurn: buildLatestTurn({
          previous: thread.latestTurn,
          turnId: event.payload.turnId,
          state: "running",
          requestedAt:
            thread.latestTurn?.turnId === event.payload.turnId
              ? thread.latestTurn.requestedAt
              : event.payload.startedAt,
          startedAt: event.payload.startedAt,
          completedAt: null,
          assistantMessageId:
            thread.latestTurn?.turnId === event.payload.turnId
              ? thread.latestTurn.assistantMessageId
              : null,
          sourceProposedPlan: thread.pendingSourceProposedPlan,
        }),
      }));
    }

    case "thread.turn-completed": {
      if (!isSessionTurnCompletedPayload(event.payload)) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...patchThreadSession(thread, {
          status: "ready",
          orchestrationStatus: "ready",
          activeTurnId: undefined,
          updatedAt: event.payload.completedAt,
        }),
        latestTurn:
          thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.turnId,
                state: "completed",
                requestedAt: thread.latestTurn?.requestedAt ?? event.payload.completedAt,
                startedAt: thread.latestTurn?.startedAt ?? event.payload.completedAt,
                completedAt: event.payload.completedAt,
                assistantMessageId: thread.latestTurn?.assistantMessageId ?? null,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
              })
            : thread.latestTurn,
      }));
    }

    case "thread.turn-restarted": {
      if (!isSessionTurnRestartedPayload(event.payload)) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...patchThreadSession(thread, {
          status: "ready",
          orchestrationStatus: "interrupted",
          activeTurnId: undefined,
          updatedAt: event.payload.restartedAt,
        }),
        latestTurn:
          thread.latestTurn === null
            ? null
            : {
                ...thread.latestTurn,
                state: "interrupted",
                startedAt: thread.latestTurn.startedAt ?? event.payload.restartedAt,
                completedAt: event.payload.restartedAt,
              },
      }));
    }

    case "thread.status-changed": {
      if (!isSessionStatusChangedPayload(event.payload)) {
        return state;
      }
      const orchestrationStatus = toOrchestrationSessionStatusFromForgeStatus(event.payload.status);
      return updateThreadState(state, event.payload.threadId, (thread) =>
        patchThreadSession(thread, {
          status: toLegacySessionStatus(orchestrationStatus),
          orchestrationStatus,
          activeTurnId:
            orchestrationStatus === "running" ? thread.session?.activeTurnId : undefined,
          updatedAt: event.payload.updatedAt,
        }),
      );
    }

    case "thread.completed": {
      if (!isSessionCompletedPayload(event.payload)) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...patchThreadSession(thread, {
          status: "closed",
          orchestrationStatus: "idle",
          activeTurnId: undefined,
          updatedAt: event.payload.completedAt,
        }),
        updatedAt: event.payload.completedAt,
      }));
    }

    case "thread.failed": {
      if (!isSessionFailedPayload(event.payload)) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...patchThreadSession(
          thread,
          {
            status: "error",
            orchestrationStatus: "error",
            activeTurnId: undefined,
            updatedAt: event.payload.failedAt,
            lastError: event.payload.error,
          },
          event.payload.error,
        ),
        updatedAt: event.payload.failedAt,
      }));
    }

    case "thread.cancelled": {
      if (!isSessionCancelledPayload(event.payload)) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...patchThreadSession(thread, {
          status: "closed",
          orchestrationStatus: "stopped",
          activeTurnId: undefined,
          updatedAt: event.payload.cancelledAt,
        }),
        updatedAt: event.payload.cancelledAt,
      }));
    }

    case "thread.session-set": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        session: mapSession(event.payload.session),
        error: event.payload.session.lastError ?? null,
        latestTurn:
          event.payload.session.status === "running" && event.payload.session.activeTurnId !== null
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.session.activeTurnId,
                state: "running",
                requestedAt:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? thread.latestTurn.requestedAt
                    : event.payload.session.updatedAt,
                startedAt:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? (thread.latestTurn.startedAt ?? event.payload.session.updatedAt)
                    : event.payload.session.updatedAt,
                completedAt: null,
                assistantMessageId:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? thread.latestTurn.assistantMessageId
                    : null,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
              })
            : thread.latestTurn,
      }));
    }

    case "thread.session-stop-requested": {
      return updateThreadState(state, event.payload.threadId, (thread) =>
        thread.session === null
          ? thread
          : {
              ...thread,
              session: {
                ...thread.session,
                status: "closed",
                orchestrationStatus: "stopped",
                activeTurnId: undefined,
                updatedAt: event.payload.createdAt,
              },
            },
      );
    }

    case "thread.proposed-plan-upserted": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const proposedPlan = mapProposedPlan(event.payload.proposedPlan);
        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== proposedPlan.id),
          proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-MAX_THREAD_PROPOSED_PLANS);
        return {
          ...thread,
          proposedPlans,
        };
      });
    }

    case "thread.turn-diff-completed": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const checkpoint = mapTurnDiffSummary({
          turnId: event.payload.turnId,
          checkpointTurnCount: event.payload.checkpointTurnCount,
          checkpointRef: event.payload.checkpointRef,
          status: event.payload.status,
          files: event.payload.files,
          assistantMessageId: event.payload.assistantMessageId,
          completedAt: event.payload.completedAt,
        });
        const existing = thread.turnDiffSummaries.find(
          (entry) => entry.turnId === checkpoint.turnId,
        );
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return thread;
        }
        const turnDiffSummaries = [
          ...thread.turnDiffSummaries.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted(
            (left, right) =>
              (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
              (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
          )
          .slice(-MAX_THREAD_CHECKPOINTS);
        const latestTurn =
          thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.turnId,
                state: checkpointStatusToLatestTurnState(event.payload.status),
                requestedAt: thread.latestTurn?.requestedAt ?? event.payload.completedAt,
                startedAt: thread.latestTurn?.startedAt ?? event.payload.completedAt,
                completedAt: event.payload.completedAt,
                assistantMessageId: event.payload.assistantMessageId,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
              })
            : thread.latestTurn;
        return {
          ...thread,
          turnDiffSummaries,
          latestTurn,
        };
      });
    }

    case "thread.agent-diff-upserted": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const existingSummary = (thread.agentDiffSummaries ?? []).find(
          (entry) => entry.turnId === event.payload.turnId,
        );
        const agentDiffSummary = mapAgentDiffSummary({
          turnId: event.payload.turnId,
          files: event.payload.files,
          source: event.payload.source,
          coverage: event.payload.coverage,
          assistantMessageId:
            event.payload.assistantMessageId ?? existingSummary?.assistantMessageId ?? null,
          completedAt: event.payload.completedAt,
        });
        const agentDiffSummaries = [
          ...(thread.agentDiffSummaries ?? []).filter(
            (entry) => entry.turnId !== agentDiffSummary.turnId,
          ),
          agentDiffSummary,
        ].toSorted(
          (left, right) =>
            left.completedAt.localeCompare(right.completedAt) ||
            left.turnId.localeCompare(right.turnId),
        );
        return {
          ...thread,
          agentDiffSummaries,
        };
      });
    }

    case "thread.reverted": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const turnDiffSummaries = thread.turnDiffSummaries
          .filter(
            (entry) =>
              entry.checkpointTurnCount !== undefined &&
              entry.checkpointTurnCount <= event.payload.turnCount,
          )
          .toSorted(
            (left, right) =>
              (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
              (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
          )
          .slice(-MAX_THREAD_CHECKPOINTS);
        const retainedTurnIds = new Set(turnDiffSummaries.map((entry) => entry.turnId));
        const agentDiffSummaries = (thread.agentDiffSummaries ?? [])
          .filter((entry) => retainedTurnIds.has(entry.turnId))
          .toSorted(
            (left, right) =>
              left.completedAt.localeCompare(right.completedAt) ||
              left.turnId.localeCompare(right.turnId),
          );
        const messages = retainThreadMessagesAfterRevert(
          thread.messages,
          retainedTurnIds,
          event.payload.turnCount,
        ).slice(-MAX_THREAD_MESSAGES);
        const proposedPlans = retainThreadProposedPlansAfterRevert(
          thread.proposedPlans,
          retainedTurnIds,
        ).slice(-MAX_THREAD_PROPOSED_PLANS);
        const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);
        const latestCheckpoint = turnDiffSummaries.at(-1) ?? null;

        return {
          ...thread,
          agentDiffSummaries,
          turnDiffSummaries,
          messages,
          proposedPlans,
          activities,
          pendingSourceProposedPlan: undefined,
          latestTurn:
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(
                    (latestCheckpoint.status ?? "ready") as "ready" | "missing" | "error",
                  ),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                },
        };
      });
    }

    case "thread.activity-appended": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const activities = [
          ...thread.activities.filter((activity) => activity.id !== event.payload.activity.id),
          { ...event.payload.activity },
        ]
          .toSorted(compareActivities)
          .slice(-MAX_THREAD_ACTIVITIES);
        return {
          ...thread,
          activities,
        };
      });
    }

    case "request.opened": {
      if (event.payload.requestType !== "design-option") {
        return state;
      }
      const pendingOptions = toDesignPendingOptions({
        requestId: event.payload.requestId,
        payload: event.payload.payload,
      });
      if (pendingOptions === null) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        updatedAt: event.payload.createdAt,
        designPendingOptions: pendingOptions,
      }));
    }

    case "request.resolved": {
      return updateThreadByDesignRequestId(state, event.payload.requestId, (thread) => ({
        ...thread,
        updatedAt: event.payload.resolvedAt,
        designPendingOptions: null,
      }));
    }

    case "request.stale": {
      return updateThreadByDesignRequestId(state, event.payload.requestId, (thread) => ({
        ...thread,
        updatedAt: event.payload.staleAt,
        designPendingOptions: null,
      }));
    }

    case "thread.design.artifact-rendered": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const artifact: DesignArtifact = {
          artifactId: event.payload.artifactId,
          title: event.payload.title,
          description: event.payload.description ?? null,
          artifactPath: event.payload.artifactPath,
          renderedAt: event.payload.renderedAt,
        };
        return {
          ...thread,
          designArtifacts: [...thread.designArtifacts, artifact],
        };
      });
    }

    case "thread.design.options-presented": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        designPendingOptions: {
          requestId: event.payload.requestId,
          prompt: event.payload.prompt,
          options: event.payload.options.map((opt) => ({
            id: opt.id,
            title: opt.title,
            description: opt.description,
            artifactId: opt.artifactId,
            artifactPath: opt.artifactPath,
          })),
          chosenOptionId: null,
        },
      }));
    }

    case "thread.design.option-chosen": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        if (!thread.designPendingOptions) return thread;
        return {
          ...thread,
          designPendingOptions: {
            ...thread.designPendingOptions,
            chosenOptionId: event.payload.chosenOptionId,
          },
        };
      });
    }

    case "thread.forked": {
      if (!isThreadForkedPayload(event.payload)) {
        return state;
      }
      const { threadId: forkThreadId, sourceThreadId } = event.payload;
      const sourceThread = state.threads.find((t) => t.id === sourceThreadId);
      const forkThread = state.threads.find((t) => t.id === forkThreadId);
      if (!sourceThread || !forkThread) {
        return state;
      }
      // oxlint-disable-next-line no-map-spread -- immutable state; copy-on-write required
      const copiedMessages: ChatMessage[] = sourceThread.messages.map((m) => ({
        ...m,
        id: newMessageId(),
      }));
      const updatedFork: Thread = {
        ...forkThread,
        forkedFromThreadId: sourceThreadId,
        messages: copiedMessages,
      };
      const threads = state.threads.map((t) => (t.id === forkThreadId ? updatedFork : t));
      const nextSummary = buildSidebarThreadSummary(updatedFork);
      const previousSummary = state.sidebarThreadsById[forkThreadId];
      const sidebarThreadsById = sidebarThreadSummariesEqual(previousSummary, nextSummary)
        ? state.sidebarThreadsById
        : { ...state.sidebarThreadsById, [forkThreadId]: nextSummary };
      return { ...state, threads, sidebarThreadsById };
    }

    case "thread.bootstrap-started":
    case "thread.bootstrap-completed":
    case "thread.bootstrap-failed":
    case "thread.bootstrap-skipped":
      return state;

    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
      return state;
  }

  return state;
}

export function applyOrchestrationEvents(
  state: AppState,
  events: ReadonlyArray<ForgeEvent>,
): AppState {
  if (events.length === 0) {
    return state;
  }
  return events.reduce((nextState, event) => applyOrchestrationEvent(nextState, event), state);
}

export const selectProjectById =
  (projectId: Project["id"] | null | undefined) =>
  (state: AppState): Project | undefined =>
    projectId ? state.projects.find((project) => project.id === projectId) : undefined;

export const selectThreadById =
  (threadId: ThreadId | null | undefined) =>
  (state: AppState): Thread | undefined =>
    threadId ? state.threads.find((thread) => thread.id === threadId) : undefined;

export const selectSidebarThreadSummaryById =
  (threadId: ThreadId | null | undefined) =>
  (state: AppState): SidebarThreadSummary | undefined =>
    threadId ? state.sidebarThreadsById[threadId] : undefined;

export const selectThreadIdsByProjectId =
  (projectId: ProjectId | null | undefined) =>
  (state: AppState): ThreadId[] =>
    projectId ? (state.threadIdsByProjectId[projectId] ?? EMPTY_THREAD_IDS) : EMPTY_THREAD_IDS;

export const selectThreadsByIds =
  (threadIds: readonly ThreadId[] | null | undefined) =>
  (state: AppState): Thread[] => {
    if (!threadIds || threadIds.length === 0) {
      return EMPTY_THREADS;
    }

    const threadsById = new Map(state.threads.map((thread) => [thread.id, thread] as const));
    const orderedThreads = threadIds.flatMap((threadId) => {
      const thread = threadsById.get(threadId);
      return thread ? [thread] : [];
    });

    return orderedThreads.length > 0 ? orderedThreads : EMPTY_THREADS;
  };

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  return updateThreadState(state, threadId, (t) => {
    if (t.error === error) return t;
    return { ...t, error };
  });
}

export function setThreadBranch(
  state: AppState,
  threadId: ThreadId,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  return updateThreadState(state, threadId, (t) => {
    if (t.branch === branch && t.worktreePath === worktreePath) return t;
    const cwdChanged = t.worktreePath !== worktreePath;
    return {
      ...t,
      branch,
      worktreePath,
      ...(cwdChanged ? { session: null } : {}),
    };
  });
}

// ── Zustand store ────────────────────────────────────────────────────

interface AppStore extends AppState {
  syncServerReadModel: (readModel: OrchestrationReadModel) => void;
  applyOrchestrationEvent: (event: ForgeEvent) => void;
  applyOrchestrationEvents: (events: ReadonlyArray<ForgeEvent>) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadBranch: (threadId: ThreadId, branch: string | null, worktreePath: string | null) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...initialState,
  syncServerReadModel: (readModel) => set((state) => syncServerReadModel(state, readModel)),
  applyOrchestrationEvent: (event) => set((state) => applyOrchestrationEvent(state, event)),
  applyOrchestrationEvents: (events) => set((state) => applyOrchestrationEvents(state, events)),
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setThreadBranch: (threadId, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadId, branch, worktreePath)),
}));
