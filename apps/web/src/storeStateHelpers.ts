import type {
  MessageId,
  OrchestrationLatestTurn,
  ProjectId,
  ThreadId,
  TurnId,
} from "@forgetools/contracts";
import type {
  ChatMessage,
  ProposedPlan,
  Project,
  Thread,
  ThreadSession,
  TurnDiffSummary,
} from "./types";
import type { AppState } from "./store";

// ── Constants ────────────────────────────────────────────────────────

export const MAX_THREAD_MESSAGES = 2_000;
export const MAX_THREAD_CHECKPOINTS = 500;
export const MAX_THREAD_PROPOSED_PLANS = 200;
export const MAX_THREAD_ACTIVITIES = 500;
export const EMPTY_THREAD_IDS: ThreadId[] = [];
export const EMPTY_THREADS: Thread[] = [];

// ── Array update primitives ──────────────────────────────────────────

export function updateThread(
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

export function updateProject(
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

// ── Thread index management ──────────────────────────────────────────

export function appendThreadIdByProjectId(
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

export function removeThreadIdByProjectId(
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

export function buildThreadIdsByProjectId(
  threads: ReadonlyArray<Thread>,
): Record<string, ThreadId[]> {
  const threadIdsByProjectId: Record<string, ThreadId[]> = {};
  for (const thread of threads) {
    const existingThreadIds = threadIdsByProjectId[thread.projectId] ?? EMPTY_THREAD_IDS;
    threadIdsByProjectId[thread.projectId] = [...existingThreadIds, thread.id];
  }
  return threadIdsByProjectId;
}

// ── Turn / checkpoint helpers ────────────────────────────────────────

export function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") {
    return "error" as const;
  }
  if (status === "missing") {
    return "interrupted" as const;
  }
  return "completed" as const;
}

export function compareActivities(
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

export function buildLatestTurn(params: {
  previous: OrchestrationLatestTurn | null;
  turnId: TurnId;
  state: OrchestrationLatestTurn["state"];
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: MessageId | null;
  sourceProposedPlan?: OrchestrationLatestTurn["sourceProposedPlan"];
}): OrchestrationLatestTurn {
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

// ── Session patching ─────────────────────────────────────────────────

export function patchSessionSlice(
  session: ThreadSession | null,
  patch: Partial<ThreadSession>,
): ThreadSession | null {
  if (session === null) {
    return null;
  }
  return { ...session, ...patch };
}

// ── Diff rebinding ───────────────────────────────────────────────────

export function rebindTurnDiffSummariesForAssistantMessage(
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>,
  turnId: TurnId,
  assistantMessageId: MessageId | null,
): TurnDiffSummary[] {
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

export function rebindAgentDiffSummariesForAssistantMessage(
  agentDiffSummaries: ReadonlyArray<TurnDiffSummary>,
  turnId: TurnId,
  assistantMessageId: MessageId | null,
): TurnDiffSummary[] {
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

// ── Revert helpers ───────────────────────────────────────────────────

export function retainThreadMessagesAfterRevert(
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

export function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<Thread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Thread["activities"] {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

export function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  retainedTurnIds: ReadonlySet<string>,
): ProposedPlan[] {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

// ── State-level thread update ────────────────────────────────────────

export function updateThreadState(
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

  return { ...state, threads };
}

export function findThreadIdByDesignRequestId(state: AppState, requestId: string): ThreadId | null {
  for (const [threadId, designSlice] of Object.entries(state.threadDesignById)) {
    if (designSlice.designPendingOptions?.requestId === requestId) {
      return threadId as ThreadId;
    }
  }
  return null;
}
