import {
  type ForgeEvent,
  type OrchestrationClientSnapshot,
  type OrchestrationReadModel,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThread,
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
} from "@forgetools/contracts";
import { Schema } from "effect";
import { newMessageId } from "./lib/utils";
import {
  mapAgentDiffSummary,
  mapMessageAttachments,
  mapProject,
  mapProposedPlan,
  mapSession,
  mapThreadAndSlices,
  mapThreadSummaryAndSlices,
  mapSidebarThreadSummaryFromContract,
  mapTurnDiffSummary,
  normalizeModelSelection,
  mapProjectScripts,
  toDesignPendingOptions,
  toLegacySessionStatus,
  toOrchestrationSessionStatusFromForgeStatus,
} from "./storeMappers";
import { buildSidebarThreadSummary, sidebarThreadSummariesEqual } from "./storeSidebar";
import {
  applyActivityToWorkLogProjectionState,
  applyLatestTurnToWorkLogProjectionState,
  applyMessageToWorkLogProjectionState,
  bootstrapWorkLogProjectionState,
  type WorkLogProjectionState,
} from "./session-logic";
import {
  appendThreadIdByProjectId,
  buildLatestTurn,
  buildThreadIdsByProjectId,
  checkpointStatusToLatestTurnState,
  compareActivities,
  findThreadIdByDesignRequestId,
  MAX_THREAD_ACTIVITIES,
  MAX_THREAD_CHECKPOINTS,
  MAX_THREAD_MESSAGES,
  MAX_THREAD_PROPOSED_PLANS,
  patchSessionSlice,
  removeThreadIdByProjectId,
  retainThreadActivitiesAfterRevert,
  retainThreadMessagesAfterRevert,
  retainThreadProposedPlansAfterRevert,
  updateProject,
  updateThreadState,
} from "./storeStateHelpers";
import { buildProposedPlanHistoryKey, buildTurnDiffHistoryKey } from "./threadHistory";
import type {
  ChatMessage,
  DesignArtifact,
  Thread,
  ThreadDesignSlice,
  ThreadDiffsSlice,
  ThreadPlansSlice,
  ThreadSessionSlice,
} from "./types";
import type { AppState } from "./store";

// ── Direct slice update helpers ──────────────────────────────────────
// Each helper produces a new AppState with the targeted slice updated.
// They replace the old dual-write pattern where event handlers wrote to
// Thread first and then extracted slices.

const EMPTY_SESSION_SLICE: ThreadSessionSlice = {
  session: null,
  latestTurn: null,
  error: null,
};

const EMPTY_DIFFS_SLICE: ThreadDiffsSlice = { turnDiffSummaries: [] };
const EMPTY_PLANS_SLICE: ThreadPlansSlice = { proposedPlans: [] };
const EMPTY_DESIGN_SLICE: ThreadDesignSlice = {
  designArtifacts: [],
  designPendingOptions: null,
};

function updateSessionSlice(
  state: AppState,
  threadId: string,
  updater: (prev: ThreadSessionSlice) => ThreadSessionSlice,
): AppState {
  const prev = state.threadSessionById[threadId] ?? EMPTY_SESSION_SLICE;
  const next = updater(prev);
  if (next === prev) return state;
  return {
    ...state,
    threadSessionById: { ...state.threadSessionById, [threadId]: next },
  };
}

function updateDiffsSlice(
  state: AppState,
  threadId: string,
  updater: (prev: ThreadDiffsSlice) => ThreadDiffsSlice,
): AppState {
  const prev = state.threadDiffsById[threadId] ?? EMPTY_DIFFS_SLICE;
  const next = updater(prev);
  if (next === prev) return state;
  return {
    ...state,
    threadDiffsById: { ...state.threadDiffsById, [threadId]: next },
  };
}

function updatePlansSlice(
  state: AppState,
  threadId: string,
  updater: (prev: ThreadPlansSlice) => ThreadPlansSlice,
): AppState {
  const prev = state.threadPlansById[threadId] ?? EMPTY_PLANS_SLICE;
  const next = updater(prev);
  if (next === prev) return state;
  return {
    ...state,
    threadPlansById: { ...state.threadPlansById, [threadId]: next },
  };
}

function updateDesignSlice(
  state: AppState,
  threadId: string,
  updater: (prev: ThreadDesignSlice) => ThreadDesignSlice,
): AppState {
  const prev = state.threadDesignById[threadId] ?? EMPTY_DESIGN_SLICE;
  const next = updater(prev);
  if (next === prev) return state;
  return {
    ...state,
    threadDesignById: { ...state.threadDesignById, [threadId]: next },
  };
}

/** Rebuild the sidebar summary for a single thread from its slices. */
function rebuildSidebarForThread(state: AppState, threadId: string): AppState {
  const thread = state.threads.find((t) => t.id === threadId);
  if (!thread) return state;
  const computedSummary = buildSidebarThreadSummary(
    thread,
    state.threadSessionById[threadId],
    state.threadPlansById[threadId],
    state.threadDesignById[threadId],
  );
  const previousSummary = state.sidebarThreadsById[threadId];
  const detailLoaded = state.threadDetailLoadedById[threadId] === true;
  const hasClientMessages = thread.messages.length > 0;
  const hasClientPlans = (state.threadPlansById[threadId]?.proposedPlans.length ?? 0) > 0;
  const nextSummary =
    !detailLoaded && previousSummary
      ? {
          ...computedSummary,
          latestUserMessageAt: hasClientMessages
            ? computedSummary.latestUserMessageAt
            : previousSummary.latestUserMessageAt,
          lastSortableActivityAt:
            hasClientMessages || hasClientPlans
              ? computedSummary.lastSortableActivityAt
              : previousSummary.lastSortableActivityAt,
          hasActionableProposedPlan: hasClientPlans
            ? computedSummary.hasActionableProposedPlan
            : previousSummary.hasActionableProposedPlan,
        }
      : computedSummary;
  if (sidebarThreadSummariesEqual(previousSummary, nextSummary)) {
    return state;
  }
  return {
    ...state,
    sidebarThreadsById: { ...state.sidebarThreadsById, [threadId]: nextSummary },
  };
}

function compareMessages(left: ChatMessage, right: ChatMessage): number {
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

function mergeMessages(
  existing: ReadonlyArray<ChatMessage>,
  incoming: ReadonlyArray<ChatMessage>,
): ChatMessage[] {
  const byId = new Map(existing.map((message) => [message.id, message] as const));
  for (const message of incoming) {
    byId.set(message.id, message);
  }
  return [...byId.values()].toSorted(compareMessages);
}

function mergePlans(
  existing: ReadonlyArray<ThreadPlansSlice["proposedPlans"][number]>,
  incoming: ReadonlyArray<ThreadPlansSlice["proposedPlans"][number]>,
): ThreadPlansSlice["proposedPlans"] {
  const byKey = new Map(existing.map((plan) => [buildProposedPlanHistoryKey(plan), plan] as const));
  for (const plan of incoming) {
    byKey.set(buildProposedPlanHistoryKey(plan), plan);
  }
  return [...byKey.values()].toSorted(
    (left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
  );
}

function mergeTurnDiffSummaries(
  existing: ReadonlyArray<ThreadDiffsSlice["turnDiffSummaries"][number]>,
  incoming: ReadonlyArray<ThreadDiffsSlice["turnDiffSummaries"][number]>,
): ThreadDiffsSlice["turnDiffSummaries"] {
  const byKey = new Map(
    existing.map((summary) => [buildTurnDiffHistoryKey(summary), summary] as const),
  );
  for (const summary of incoming) {
    byKey.set(buildTurnDiffHistoryKey(summary), summary);
  }
  return [...byKey.values()].toSorted(
    (left, right) =>
      left.completedAt.localeCompare(right.completedAt) || left.turnId.localeCompare(right.turnId),
  );
}

function mergeActivities(
  existing: ReadonlyArray<Thread["activities"][number]>,
  incoming: ReadonlyArray<Thread["activities"][number]>,
): Thread["activities"] {
  const byId = new Map(existing.map((activity) => [activity.id, activity] as const));
  for (const activity of incoming) {
    byId.set(activity.id, activity);
  }
  return [...byId.values()].toSorted(compareActivities);
}

// ── Schema validators ────────────────────────────────────────────────

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

function setThreadWorkLogState(
  state: AppState,
  threadId: Thread["id"],
  workLogState: WorkLogProjectionState,
): AppState {
  const previous = state.threadWorkLogById?.[threadId];
  if (previous === workLogState) {
    return state;
  }
  return {
    ...state,
    threadWorkLogById: {
      ...state.threadWorkLogById,
      [threadId]: workLogState,
    },
  };
}

function deleteThreadWorkLogState(state: AppState, threadId: Thread["id"]): AppState {
  if (!state.threadWorkLogById || !(threadId in state.threadWorkLogById)) {
    return state;
  }
  const threadWorkLogById = { ...state.threadWorkLogById };
  delete threadWorkLogById[threadId];
  return {
    ...state,
    threadWorkLogById,
  };
}

function rebuildThreadWorkLogState(state: AppState, threadId: Thread["id"]): AppState {
  const thread = state.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    return state;
  }
  const latestTurn = state.threadSessionById[threadId]?.latestTurn ?? null;
  return setThreadWorkLogState(
    state,
    threadId,
    bootstrapWorkLogProjectionState(thread.activities, {
      messages: thread.messages,
      latestTurn,
    }),
  );
}

// ── Project events ───────────────────────────────────────────────────

function handleProjectEvent(state: AppState, event: ForgeEvent): AppState | undefined {
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
  }

  return undefined;
}

// ── Thread lifecycle events ──────────────────────────────────────────

function handleThreadLifecycleEvent(state: AppState, event: ForgeEvent): AppState | undefined {
  switch (event.type) {
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
      const mapped = mapThreadAndSlices(
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
      const nextThread = mapped.thread;
      let threads = existing
        ? state.threads.map((thread) => (thread.id === nextThread.id ? nextThread : thread))
        : [...state.threads, nextThread];

      // Initialize slices for the new thread.
      const threadSessionById = {
        ...state.threadSessionById,
        [nextThread.id]: mapped.sessionSlice,
      };
      const threadDiffsById = {
        ...state.threadDiffsById,
        [nextThread.id]: mapped.diffsSlice,
      };
      const threadPlansById = {
        ...state.threadPlansById,
        [nextThread.id]: mapped.plansSlice,
      };
      const threadDesignById = {
        ...state.threadDesignById,
        [nextThread.id]: mapped.designSlice,
      };

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
          const parentSummary = buildSidebarThreadSummary(
            updatedParent,
            threadSessionById[parentThreadId],
            threadPlansById[parentThreadId],
            threadDesignById[parentThreadId],
          );
          updatedSidebarThreadsById = {
            ...updatedSidebarThreadsById,
            [parentThreadId]: parentSummary,
          };
        }
      }

      const nextSummary = buildSidebarThreadSummary(
        nextThread,
        mapped.sessionSlice,
        mapped.plansSlice,
        mapped.designSlice,
      );
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
      const nextState = {
        ...state,
        threads,
        sidebarThreadsById,
        threadIdsByProjectId,
        threadSessionById,
        threadDiffsById,
        threadPlansById,
        threadDesignById,
        threadDetailLoadedById: {
          ...state.threadDetailLoadedById,
          [nextThread.id]: true,
        },
      };
      return setThreadWorkLogState(
        nextState,
        nextThread.id,
        bootstrapWorkLogProjectionState([], {
          latestTurn: mapped.sessionSlice.latestTurn,
          messages: [],
        }),
      );
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
      // Clean up per-thread slices.
      const threadSessionById = { ...state.threadSessionById };
      const threadDiffsById = { ...state.threadDiffsById };
      const threadPlansById = { ...state.threadPlansById };
      const threadDesignById = { ...state.threadDesignById };
      const threadDetailLoadedById = { ...state.threadDetailLoadedById };
      const streamingMessageByThreadId = { ...state.streamingMessageByThreadId };
      delete threadSessionById[event.payload.threadId];
      delete threadDiffsById[event.payload.threadId];
      delete threadPlansById[event.payload.threadId];
      delete threadDesignById[event.payload.threadId];
      delete threadDetailLoadedById[event.payload.threadId];
      delete streamingMessageByThreadId[event.payload.threadId];
      return deleteThreadWorkLogState(
        {
          ...state,
          threads,
          sidebarThreadsById,
          threadIdsByProjectId,
          threadSessionById,
          threadDiffsById,
          threadPlansById,
          threadDesignById,
          threadDetailLoadedById,
          streamingMessageByThreadId,
        },
        event.payload.threadId,
      );
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
      const nextSummary = buildSidebarThreadSummary(
        updatedFork,
        state.threadSessionById[forkThreadId],
        state.threadPlansById[forkThreadId],
        state.threadDesignById[forkThreadId],
      );
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
  }

  return undefined;
}

// ── Session events ───────────────────────────────────────────────────

function handleSessionEvent(state: AppState, event: ForgeEvent): AppState | undefined {
  switch (event.type) {
    case "thread.status-changed": {
      if (!isSessionStatusChangedPayload(event.payload)) {
        return state;
      }
      const orchestrationStatus = toOrchestrationSessionStatusFromForgeStatus(event.payload.status);
      return updateSessionSlice(state, event.payload.threadId, (slice) => ({
        ...slice,
        session: patchSessionSlice(slice.session, {
          status: toLegacySessionStatus(orchestrationStatus),
          orchestrationStatus,
          activeTurnId: orchestrationStatus === "running" ? slice.session?.activeTurnId : undefined,
          updatedAt: event.payload.updatedAt,
        }),
      }));
    }

    case "thread.completed": {
      if (!isSessionCompletedPayload(event.payload)) {
        return state;
      }
      let next = updateSessionSlice(state, event.payload.threadId, (slice) => ({
        ...slice,
        session: patchSessionSlice(slice.session, {
          status: "closed",
          orchestrationStatus: "idle",
          activeTurnId: undefined,
          updatedAt: event.payload.completedAt,
        }),
      }));
      next = updateThreadState(next, event.payload.threadId, (thread) => ({
        ...thread,
        updatedAt: event.payload.completedAt,
      }));
      return next;
    }

    case "thread.failed": {
      if (!isSessionFailedPayload(event.payload)) {
        return state;
      }
      let next = updateSessionSlice(state, event.payload.threadId, (slice) => ({
        ...slice,
        session: patchSessionSlice(slice.session, {
          status: "error",
          orchestrationStatus: "error",
          activeTurnId: undefined,
          updatedAt: event.payload.failedAt,
          lastError: event.payload.error,
        }),
        error: event.payload.error,
      }));
      next = updateThreadState(next, event.payload.threadId, (thread) => ({
        ...thread,
        updatedAt: event.payload.failedAt,
      }));
      return next;
    }

    case "thread.cancelled": {
      if (!isSessionCancelledPayload(event.payload)) {
        return state;
      }
      let next = updateSessionSlice(state, event.payload.threadId, (slice) => ({
        ...slice,
        session: patchSessionSlice(slice.session, {
          status: "closed",
          orchestrationStatus: "stopped",
          activeTurnId: undefined,
          updatedAt: event.payload.cancelledAt,
        }),
      }));
      next = updateThreadState(next, event.payload.threadId, (thread) => ({
        ...thread,
        updatedAt: event.payload.cancelledAt,
      }));
      return next;
    }

    case "thread.session-set": {
      return updateSessionSlice(state, event.payload.threadId, (slice) => {
        const session = mapSession(event.payload.session);
        const latestTurn =
          event.payload.session.status === "running" && event.payload.session.activeTurnId !== null
            ? buildLatestTurn({
                previous: slice.latestTurn,
                turnId: event.payload.session.activeTurnId,
                state: "running",
                requestedAt:
                  slice.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? slice.latestTurn.requestedAt
                    : event.payload.session.updatedAt,
                startedAt:
                  slice.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? (slice.latestTurn.startedAt ?? event.payload.session.updatedAt)
                    : event.payload.session.updatedAt,
                completedAt: null,
                assistantMessageId:
                  slice.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? slice.latestTurn.assistantMessageId
                    : null,
                sourceProposedPlan: slice.pendingSourceProposedPlan,
              })
            : slice.latestTurn;
        return {
          ...slice,
          session,
          error: event.payload.session.lastError ?? null,
          latestTurn,
        };
      });
    }

    case "thread.session-stop-requested": {
      return updateSessionSlice(state, event.payload.threadId, (slice) =>
        slice.session === null
          ? slice
          : {
              ...slice,
              session: {
                ...slice.session,
                status: "closed",
                orchestrationStatus: "stopped",
                activeTurnId: undefined,
                updatedAt: event.payload.createdAt,
              },
            },
      );
    }
  }

  return undefined;
}

// ── Message events ───────────────────────────────────────────────────

function handleMessageEvent(state: AppState, event: ForgeEvent): AppState | undefined {
  switch (event.type) {
    case "thread.message-sent": {
      if (
        !isThreadMessageSentPayload(event.payload) &&
        !isSessionMessageSentPayload(event.payload)
      ) {
        return state;
      }

      const threadId = event.payload.threadId;
      const messageUpdatedAt = isThreadMessageSentPayload(event.payload)
        ? event.payload.updatedAt
        : event.payload.createdAt;
      const attachments =
        isThreadMessageSentPayload(event.payload) && event.payload.attachments !== undefined
          ? mapMessageAttachments(event.payload.attachments)
          : undefined;
      const attribution =
        isThreadMessageSentPayload(event.payload) && event.payload.attribution !== undefined
          ? event.payload.attribution
          : undefined;
      const messageText = isThreadMessageSentPayload(event.payload)
        ? event.payload.text
        : event.payload.content;

      // ── Streaming assistant delta: write to the streaming buffer only ──
      if (event.payload.streaming && event.payload.role === "assistant") {
        const existing = state.streamingMessageByThreadId[threadId];
        const streamingMessage: ChatMessage = existing
          ? {
              ...existing,
              text: `${existing.text}${messageText}`,
              ...(event.payload.turnId !== undefined ? { turnId: event.payload.turnId } : {}),
              ...(existing.sequence !== undefined
                ? {}
                : event.sequence !== undefined
                  ? { sequence: event.sequence }
                  : {}),
              ...(attachments !== undefined ? { attachments } : {}),
              ...(attribution !== undefined ? { attribution } : {}),
            }
          : {
              id: event.payload.messageId,
              role: "assistant" as const,
              text: messageText,
              turnId: event.payload.turnId,
              createdAt: event.payload.createdAt,
              ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
              streaming: true,
              ...(attachments !== undefined ? { attachments } : {}),
              ...(attribution !== undefined ? { attribution } : {}),
            };

        // Update latestTurn to "running" via the session slice.
        const nextState = updateSessionSlice(state, threadId, (slice) => {
          if (
            event.payload.turnId === null ||
            (slice.latestTurn !== null && slice.latestTurn.turnId !== event.payload.turnId)
          ) {
            return slice;
          }
          return {
            ...slice,
            latestTurn: buildLatestTurn({
              previous: slice.latestTurn,
              turnId: event.payload.turnId,
              state: "running",
              requestedAt:
                slice.latestTurn?.turnId === event.payload.turnId
                  ? slice.latestTurn.requestedAt
                  : event.payload.createdAt,
              startedAt:
                slice.latestTurn?.turnId === event.payload.turnId
                  ? (slice.latestTurn.startedAt ?? event.payload.createdAt)
                  : event.payload.createdAt,
              sourceProposedPlan: slice.pendingSourceProposedPlan,
              completedAt:
                slice.latestTurn?.turnId === event.payload.turnId
                  ? (slice.latestTurn.completedAt ?? null)
                  : null,
              assistantMessageId: event.payload.messageId,
            }),
          };
        });

        return {
          ...nextState,
          streamingMessageByThreadId: {
            ...nextState.streamingMessageByThreadId,
            [threadId]: streamingMessage,
          },
        };
      }

      // ── Completion or non-streaming message: append to committed list ──
      const streamingEntry = state.streamingMessageByThreadId[threadId];

      // Update Thread.messages (the only Thread field this event writes to)
      let nextState = updateThreadState(state, threadId, (thread) => {
        const existingMessage = thread.messages.find(
          (entry) => entry.id === event.payload.messageId,
        );

        let finalMessage: ChatMessage;
        if (streamingEntry && streamingEntry.id === event.payload.messageId) {
          finalMessage = {
            ...streamingEntry,
            text: messageText.length > 0 ? messageText : streamingEntry.text,
            streaming: false,
            completedAt: messageUpdatedAt,
            ...(event.payload.turnId !== undefined ? { turnId: event.payload.turnId } : {}),
            ...(attachments !== undefined ? { attachments } : {}),
            ...(attribution !== undefined ? { attribution } : {}),
          };
        } else {
          finalMessage = {
            id: event.payload.messageId,
            role: event.payload.role as ChatMessage["role"],
            text: messageText,
            turnId: event.payload.turnId,
            createdAt: event.payload.createdAt,
            ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
            streaming: false,
            completedAt: messageUpdatedAt,
            ...(attachments !== undefined ? { attachments } : {}),
            ...(attribution !== undefined ? { attribution } : {}),
          };
        }

        const messages = existingMessage
          ? thread.messages
          : [...thread.messages, finalMessage].slice(-MAX_THREAD_MESSAGES);

        if (messages === thread.messages) {
          return thread;
        }
        return { ...thread, messages };
      });

      // Update session slice (latestTurn) for assistant message completion
      nextState = updateSessionSlice(nextState, threadId, (slice) => {
        if (
          event.payload.role !== "assistant" ||
          event.payload.turnId === null ||
          (slice.latestTurn !== null && slice.latestTurn.turnId !== event.payload.turnId)
        ) {
          return slice;
        }
        return {
          ...slice,
          latestTurn: buildLatestTurn({
            previous: slice.latestTurn,
            turnId: event.payload.turnId,
            state:
              slice.latestTurn?.state === "interrupted"
                ? "interrupted"
                : slice.latestTurn?.state === "error"
                  ? "error"
                  : "completed",
            requestedAt:
              slice.latestTurn?.turnId === event.payload.turnId
                ? slice.latestTurn.requestedAt
                : event.payload.createdAt,
            startedAt:
              slice.latestTurn?.turnId === event.payload.turnId
                ? (slice.latestTurn.startedAt ?? event.payload.createdAt)
                : event.payload.createdAt,
            sourceProposedPlan: slice.pendingSourceProposedPlan,
            completedAt: messageUpdatedAt,
            assistantMessageId: event.payload.messageId,
          }),
        };
      });

      // Clear the streaming buffer for this thread
      const { [threadId]: _cleared, ...remainingStreaming } = nextState.streamingMessageByThreadId;
      const stateWithClearedBuffer =
        _cleared !== undefined
          ? { ...nextState, streamingMessageByThreadId: remainingStreaming }
          : nextState;

      // Update work log projection
      const nextThread = stateWithClearedBuffer.threads.find((t) => t.id === threadId);
      if (!nextThread) return stateWithClearedBuffer;
      const workLogState = stateWithClearedBuffer.threadWorkLogById?.[threadId];
      if (!workLogState) return stateWithClearedBuffer;
      const latestMessage = nextThread.messages.find((m) => m.id === event.payload.messageId);
      if (!latestMessage) return stateWithClearedBuffer;
      let nextWorkLogState = workLogState;
      if (latestMessage.role === "assistant") {
        nextWorkLogState = applyMessageToWorkLogProjectionState(nextWorkLogState, latestMessage);
      }
      const nextLatestTurn = stateWithClearedBuffer.threadSessionById[threadId]?.latestTurn ?? null;
      if (nextLatestTurn !== workLogState.latestTurn) {
        nextWorkLogState = applyLatestTurnToWorkLogProjectionState(
          nextWorkLogState,
          nextLatestTurn,
        );
      }
      return setThreadWorkLogState(stateWithClearedBuffer, threadId, nextWorkLogState);
    }
  }

  return undefined;
}

// ── Turn events ──────────────────────────────────────────────────────

function handleTurnEvent(state: AppState, event: ForgeEvent): AppState | undefined {
  switch (event.type) {
    case "thread.turn-start-requested": {
      // modelSelection/runtimeMode/interactionMode stay on Thread;
      // pendingSourceProposedPlan goes to the session slice.
      let next = updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: normalizeModelSelection(event.payload.modelSelection) }
          : {}),
        runtimeMode: event.payload.runtimeMode,
        interactionMode: event.payload.interactionMode,
      }));
      next = updateSessionSlice(next, event.payload.threadId, (slice) => ({
        ...slice,
        pendingSourceProposedPlan: event.payload.sourceProposedPlan,
      }));
      return next;
    }

    case "thread.turn-interrupt-requested": {
      if (event.payload.turnId === undefined) {
        return state;
      }
      return updateSessionSlice(state, event.payload.threadId, (slice) => {
        const latestTurn = slice.latestTurn;
        if (latestTurn === null || latestTurn.turnId !== event.payload.turnId) {
          return slice;
        }
        return {
          ...slice,
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

    case "thread.turn-started": {
      if (!isSessionTurnStartedPayload(event.payload)) {
        return state;
      }
      const nextState = updateSessionSlice(state, event.payload.threadId, (slice) => ({
        ...slice,
        session: patchSessionSlice(slice.session, {
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: event.payload.turnId,
          updatedAt: event.payload.startedAt,
        }),
        latestTurn: buildLatestTurn({
          previous: slice.latestTurn,
          turnId: event.payload.turnId,
          state: "running",
          requestedAt:
            slice.latestTurn?.turnId === event.payload.turnId
              ? slice.latestTurn.requestedAt
              : event.payload.startedAt,
          startedAt: event.payload.startedAt,
          completedAt: null,
          assistantMessageId:
            slice.latestTurn?.turnId === event.payload.turnId
              ? slice.latestTurn.assistantMessageId
              : null,
          sourceProposedPlan: slice.pendingSourceProposedPlan,
        }),
      }));
      const latestTurn = nextState.threadSessionById[event.payload.threadId]?.latestTurn ?? null;
      const workLogState = nextState.threadWorkLogById?.[event.payload.threadId];
      return workLogState
        ? setThreadWorkLogState(
            nextState,
            event.payload.threadId,
            applyLatestTurnToWorkLogProjectionState(workLogState, latestTurn),
          )
        : nextState;
    }

    case "thread.turn-completed": {
      if (!isSessionTurnCompletedPayload(event.payload)) {
        return state;
      }
      const nextState = updateSessionSlice(state, event.payload.threadId, (slice) => ({
        ...slice,
        session: patchSessionSlice(slice.session, {
          status: "ready",
          orchestrationStatus: "ready",
          activeTurnId: undefined,
          updatedAt: event.payload.completedAt,
        }),
        latestTurn:
          slice.latestTurn === null || slice.latestTurn.turnId === event.payload.turnId
            ? buildLatestTurn({
                previous: slice.latestTurn,
                turnId: event.payload.turnId,
                state: "completed",
                requestedAt: slice.latestTurn?.requestedAt ?? event.payload.completedAt,
                startedAt: slice.latestTurn?.startedAt ?? event.payload.completedAt,
                completedAt: event.payload.completedAt,
                assistantMessageId: slice.latestTurn?.assistantMessageId ?? null,
                sourceProposedPlan: slice.pendingSourceProposedPlan,
              })
            : slice.latestTurn,
      }));
      const latestTurn = nextState.threadSessionById[event.payload.threadId]?.latestTurn ?? null;
      const workLogState = nextState.threadWorkLogById?.[event.payload.threadId];
      return workLogState
        ? setThreadWorkLogState(
            nextState,
            event.payload.threadId,
            applyLatestTurnToWorkLogProjectionState(workLogState, latestTurn),
          )
        : nextState;
    }

    case "thread.turn-restarted": {
      if (!isSessionTurnRestartedPayload(event.payload)) {
        return state;
      }
      const nextState = updateSessionSlice(state, event.payload.threadId, (slice) => ({
        ...slice,
        session: patchSessionSlice(slice.session, {
          status: "ready",
          orchestrationStatus: "interrupted",
          activeTurnId: undefined,
          updatedAt: event.payload.restartedAt,
        }),
        latestTurn:
          slice.latestTurn === null
            ? null
            : {
                ...slice.latestTurn,
                state: "interrupted" as const,
                startedAt: slice.latestTurn.startedAt ?? event.payload.restartedAt,
                completedAt: event.payload.restartedAt,
              },
      }));
      const latestTurn = nextState.threadSessionById[event.payload.threadId]?.latestTurn ?? null;
      const workLogState = nextState.threadWorkLogById?.[event.payload.threadId];
      return workLogState
        ? setThreadWorkLogState(
            nextState,
            event.payload.threadId,
            applyLatestTurnToWorkLogProjectionState(workLogState, latestTurn),
          )
        : nextState;
    }
  }

  return undefined;
}

// ── Diff events ──────────────────────────────────────────────────────

function handleDiffEvent(state: AppState, event: ForgeEvent): AppState | undefined {
  switch (event.type) {
    case "thread.activity-inline-diff-upserted": {
      const nextState = updateThreadState(state, event.payload.threadId, (thread) => {
        let changed = false;
        const activities = thread.activities.map((activity) => {
          if (activity.id !== event.payload.activityId) {
            return activity;
          }
          changed = true;
          const payload =
            typeof activity.payload === "object" && activity.payload !== null
              ? activity.payload
              : {};
          return {
            ...activity,
            payload: {
              ...payload,
              inlineDiff: event.payload.inlineDiff,
            },
          };
        });
        if (!changed) {
          return thread;
        }
        return {
          ...thread,
          activities,
          updatedAt: event.payload.updatedAt,
        };
      });
      return nextState === state
        ? state
        : rebuildThreadWorkLogState(nextState, event.payload.threadId);
    }

    case "thread.turn-diff-completed": {
      // Update diffs slice
      let nextState = updateDiffsSlice(state, event.payload.threadId, (diffsSlice) => {
        const checkpoint = mapTurnDiffSummary({
          turnId: event.payload.turnId,
          checkpointTurnCount: event.payload.checkpointTurnCount,
          checkpointRef: event.payload.checkpointRef,
          status: event.payload.status,
          files: event.payload.files,
          assistantMessageId: event.payload.assistantMessageId,
          completedAt: event.payload.completedAt,
        });
        const existingReadyCheckpoint = diffsSlice.turnDiffSummaries.find(
          (entry) =>
            entry.turnId === checkpoint.turnId &&
            entry.provenance === "workspace" &&
            entry.status !== "missing",
        );
        if (existingReadyCheckpoint && checkpoint.status === "missing") {
          return diffsSlice;
        }
        const historyKey = buildTurnDiffHistoryKey(checkpoint);
        if (
          diffsSlice.turnDiffSummaries.some(
            (entry) => buildTurnDiffHistoryKey(entry) === historyKey,
          )
        ) {
          return diffsSlice;
        }
        const turnDiffSummaries = [...diffsSlice.turnDiffSummaries, checkpoint]
          .toSorted(
            (left, right) =>
              left.completedAt.localeCompare(right.completedAt) ||
              buildTurnDiffHistoryKey(left).localeCompare(buildTurnDiffHistoryKey(right)),
          )
          .slice(-MAX_THREAD_CHECKPOINTS);
        return { ...diffsSlice, turnDiffSummaries };
      });

      // Update session slice's latestTurn
      nextState = updateSessionSlice(nextState, event.payload.threadId, (slice) => {
        if (slice.latestTurn !== null && slice.latestTurn.turnId !== event.payload.turnId) {
          return slice;
        }
        return {
          ...slice,
          latestTurn: buildLatestTurn({
            previous: slice.latestTurn,
            turnId: event.payload.turnId,
            state: checkpointStatusToLatestTurnState(event.payload.status),
            requestedAt: slice.latestTurn?.requestedAt ?? event.payload.completedAt,
            startedAt: slice.latestTurn?.startedAt ?? event.payload.completedAt,
            completedAt: event.payload.completedAt,
            assistantMessageId: event.payload.assistantMessageId,
            sourceProposedPlan: slice.pendingSourceProposedPlan,
          }),
        };
      });

      return nextState;
    }

    case "thread.agent-diff-upserted": {
      return updateDiffsSlice(state, event.payload.threadId, (diffsSlice) => {
        const agentDiffSummary = mapAgentDiffSummary({
          turnId: event.payload.turnId,
          files: event.payload.files,
          source: event.payload.source,
          coverage: event.payload.coverage,
          assistantMessageId: event.payload.assistantMessageId ?? null,
          completedAt: event.payload.completedAt,
        });
        const existingSummaries = diffsSlice.agentDiffSummaries ?? [];
        const historyKey = buildTurnDiffHistoryKey(agentDiffSummary);
        if (existingSummaries.some((entry) => buildTurnDiffHistoryKey(entry) === historyKey)) {
          return diffsSlice;
        }
        const agentDiffSummaries = [...existingSummaries, agentDiffSummary].toSorted(
          (left, right) =>
            left.completedAt.localeCompare(right.completedAt) ||
            buildTurnDiffHistoryKey(left).localeCompare(buildTurnDiffHistoryKey(right)),
        );
        return { ...diffsSlice, agentDiffSummaries };
      });
    }

    case "thread.proposed-plan-upserted": {
      return updatePlansSlice(state, event.payload.threadId, (plansSlice) => {
        const proposedPlan = mapProposedPlan(event.payload.proposedPlan);
        const historyKey = buildProposedPlanHistoryKey(proposedPlan);
        if (
          plansSlice.proposedPlans.some(
            (entry) => buildProposedPlanHistoryKey(entry) === historyKey,
          )
        ) {
          return plansSlice;
        }
        const proposedPlans = [...plansSlice.proposedPlans, proposedPlan]
          .toSorted(
            (left, right) =>
              left.updatedAt.localeCompare(right.updatedAt) ||
              buildProposedPlanHistoryKey(left).localeCompare(buildProposedPlanHistoryKey(right)),
          )
          .slice(-MAX_THREAD_PROPOSED_PLANS);
        return { ...plansSlice, proposedPlans };
      });
    }
  }

  return undefined;
}

// ── Activity events ──────────────────────────────────────────────────

function handleActivityEvent(state: AppState, event: ForgeEvent): AppState | undefined {
  switch (event.type) {
    case "thread.activity-appended": {
      const activity = {
        ...event.payload.activity,
        sequence: event.sequence,
      };
      const nextState = updateThreadState(state, event.payload.threadId, (thread) => {
        // Append-only: skip duplicates (idempotent for replay/recovery)
        if (thread.activities.some((a) => a.id === activity.id)) {
          return thread;
        }
        const activities = [...thread.activities, activity]
          .toSorted(compareActivities)
          .slice(-MAX_THREAD_ACTIVITIES);
        return {
          ...thread,
          activities,
        };
      });
      const workLogState = nextState.threadWorkLogById?.[event.payload.threadId];
      return workLogState
        ? setThreadWorkLogState(
            nextState,
            event.payload.threadId,
            applyActivityToWorkLogProjectionState(workLogState, activity),
          )
        : nextState;
    }
  }

  return undefined;
}

// ── Design events ────────────────────────────────────────────────────

function handleDesignEvent(state: AppState, event: ForgeEvent): AppState | undefined {
  switch (event.type) {
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
      let next = updateDesignSlice(state, event.payload.threadId, (designSlice) => ({
        ...designSlice,
        designPendingOptions: pendingOptions,
      }));
      next = updateThreadState(next, event.payload.threadId, (thread) => ({
        ...thread,
        updatedAt: event.payload.createdAt,
      }));
      return next;
    }

    case "request.resolved": {
      const threadId = findThreadIdByDesignRequestId(state, event.payload.requestId);
      if (!threadId) return state;
      let next = updateDesignSlice(state, threadId, (designSlice) => ({
        ...designSlice,
        designPendingOptions: null,
      }));
      next = updateThreadState(next, threadId, (thread) => ({
        ...thread,
        updatedAt: event.payload.resolvedAt,
      }));
      return next;
    }

    case "request.stale": {
      const threadId = findThreadIdByDesignRequestId(state, event.payload.requestId);
      if (!threadId) return state;
      let next = updateDesignSlice(state, threadId, (designSlice) => ({
        ...designSlice,
        designPendingOptions: null,
      }));
      next = updateThreadState(next, threadId, (thread) => ({
        ...thread,
        updatedAt: event.payload.staleAt,
      }));
      return next;
    }

    case "thread.design.artifact-rendered": {
      return updateDesignSlice(state, event.payload.threadId, (designSlice) => {
        const artifact: DesignArtifact = {
          artifactId: event.payload.artifactId,
          title: event.payload.title,
          description: event.payload.description ?? null,
          artifactPath: event.payload.artifactPath,
          renderedAt: event.payload.renderedAt,
        };
        return {
          ...designSlice,
          designArtifacts: [...designSlice.designArtifacts, artifact],
        };
      });
    }

    case "thread.design.options-presented": {
      return updateDesignSlice(state, event.payload.threadId, (designSlice) => ({
        ...designSlice,
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
      return updateDesignSlice(state, event.payload.threadId, (designSlice) => {
        if (!designSlice.designPendingOptions) return designSlice;
        return {
          ...designSlice,
          designPendingOptions: {
            ...designSlice.designPendingOptions,
            chosenOptionId: event.payload.chosenOptionId,
          },
        };
      });
    }
  }

  return undefined;
}

// ── Revert events ────────────────────────────────────────────────────

function handleRevertEvent(state: AppState, event: ForgeEvent): AppState | undefined {
  switch (event.type) {
    case "thread.reverted": {
      const threadId = event.payload.threadId;

      // 1. Compute the retained turn diff summaries from the diffs slice.
      const diffsSlice = state.threadDiffsById[threadId] ?? EMPTY_DIFFS_SLICE;
      const turnDiffSummaries = diffsSlice.turnDiffSummaries
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
      const agentDiffSummaries = (diffsSlice.agentDiffSummaries ?? [])
        .filter((entry) => retainedTurnIds.has(entry.turnId))
        .toSorted(
          (left, right) =>
            left.completedAt.localeCompare(right.completedAt) ||
            left.turnId.localeCompare(right.turnId),
        );

      // 2. Update Thread (messages, activities)
      let nextState = updateThreadState(state, threadId, (thread) => {
        const messages = retainThreadMessagesAfterRevert(
          thread.messages,
          retainedTurnIds,
          event.payload.turnCount,
        ).slice(-MAX_THREAD_MESSAGES);
        const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);
        return { ...thread, messages, activities };
      });

      // 3. Update diffs slice
      nextState = updateDiffsSlice(nextState, threadId, () => ({
        turnDiffSummaries,
        agentDiffSummaries,
      }));

      // 4. Update plans slice
      const plansSlice = state.threadPlansById[threadId] ?? EMPTY_PLANS_SLICE;
      const proposedPlans = retainThreadProposedPlansAfterRevert(
        plansSlice.proposedPlans,
        retainedTurnIds,
      ).slice(-MAX_THREAD_PROPOSED_PLANS);
      nextState = updatePlansSlice(nextState, threadId, () => ({ proposedPlans }));

      // 5. Update session slice (latestTurn, clear pendingSourceProposedPlan)
      const latestCheckpoint = turnDiffSummaries.at(-1) ?? null;
      nextState = updateSessionSlice(nextState, threadId, (slice) => ({
        ...slice,
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
      }));

      return nextState;
    }
  }

  return undefined;
}

// ── No-op events ─────────────────────────────────────────────────────

function handleNoopEvent(_state: AppState, event: ForgeEvent): AppState | undefined {
  switch (event.type) {
    case "thread.interactive-request-response-requested":
      return _state;
  }

  return undefined;
}

// ── Sync from server read model ──────────────────────────────────────

export function applyThreadDetailSnapshot(
  state: AppState,
  snapshot: OrchestrationThreadDetailSnapshot,
): AppState {
  const threadId = snapshot.thread.id;
  const existingThread = state.threads.find((thread) => thread.id === threadId);
  if (!existingThread) {
    return state;
  }

  const pendingRequests = state.threadSessionById[threadId]?.pendingRequests ?? [];
  const mapped = mapThreadAndSlices(snapshot.thread, pendingRequests);
  const mergedThread: Thread = {
    ...mapped.thread,
    childThreadIds:
      mapped.thread.childThreadIds && mapped.thread.childThreadIds.length > 0
        ? mapped.thread.childThreadIds
        : (existingThread.childThreadIds ?? []),
    messages: mergeMessages(existingThread.messages, mapped.thread.messages),
    activities: mergeActivities(existingThread.activities, mapped.thread.activities),
  };

  const nextState: AppState = {
    ...state,
    threads: state.threads.map((thread) => (thread.id === threadId ? mergedThread : thread)),
    threadSessionById: {
      ...state.threadSessionById,
      [threadId]: mapped.sessionSlice,
    },
    threadDiffsById: {
      ...state.threadDiffsById,
      [threadId]: {
        turnDiffSummaries: mergeTurnDiffSummaries(
          state.threadDiffsById[threadId]?.turnDiffSummaries ?? [],
          mapped.diffsSlice.turnDiffSummaries,
        ),
        agentDiffSummaries: mergeTurnDiffSummaries(
          state.threadDiffsById[threadId]?.agentDiffSummaries ?? [],
          mapped.diffsSlice.agentDiffSummaries ?? [],
        ),
      },
    },
    threadPlansById: {
      ...state.threadPlansById,
      [threadId]: {
        proposedPlans: mergePlans(
          state.threadPlansById[threadId]?.proposedPlans ?? [],
          mapped.plansSlice.proposedPlans,
        ),
      },
    },
    threadDesignById: {
      ...state.threadDesignById,
      [threadId]: {
        designArtifacts: state.threadDesignById[threadId]?.designArtifacts ?? [],
        designPendingOptions: mapped.designSlice.designPendingOptions,
      },
    },
    threadWorkLogById: {
      ...state.threadWorkLogById,
      [threadId]: bootstrapWorkLogProjectionState(mergedThread.activities, {
        messages: mergedThread.messages,
        latestTurn: mapped.sessionSlice.latestTurn,
      }),
    },
    threadDetailLoadedById: {
      ...state.threadDetailLoadedById,
      [threadId]: true,
    },
  };

  return rebuildSidebarForThread(nextState, threadId);
}

export function syncServerReadModel(
  state: AppState,
  readModel: OrchestrationClientSnapshot | OrchestrationReadModel,
): AppState {
  const projects = readModel.projects
    .filter((project) => project.deletedAt === null)
    .map(mapProject);
  const pendingRequestsByThreadId = new Map<
    string,
    Array<(typeof readModel.pendingRequests)[number]>
  >();
  for (const pendingRequest of readModel.pendingRequests) {
    const requestsForThread = pendingRequestsByThreadId.get(pendingRequest.threadId) ?? [];
    requestsForThread.push(pendingRequest);
    pendingRequestsByThreadId.set(pendingRequest.threadId, requestsForThread);
  }

  const mappedResults = readModel.threads
    .filter((thread) => thread.deletedAt === null)
    .map((thread) =>
      "messages" in thread
        ? {
            source: null,
            mapped: mapThreadAndSlices(thread, pendingRequestsByThreadId.get(thread.id) ?? []),
          }
        : {
            source: thread,
            mapped: mapThreadSummaryAndSlices(
              thread,
              pendingRequestsByThreadId.get(thread.id) ?? [],
            ),
          },
    );

  const existingThreadsById = new Map(state.threads.map((thread) => [thread.id, thread] as const));
  const threads = mappedResults.map(({ source, mapped }) => {
    const existingThread = existingThreadsById.get(mapped.thread.id);
    const detailLoaded = state.threadDetailLoadedById[mapped.thread.id] === true;
    if (source === null || !existingThread || !detailLoaded) {
      return mapped.thread;
    }
    return {
      ...mapped.thread,
      messages: existingThread.messages,
      activities: existingThread.activities,
      childThreadIds:
        existingThread.childThreadIds && existingThread.childThreadIds.length > 0
          ? existingThread.childThreadIds
          : (mapped.thread.childThreadIds ?? []),
    };
  });
  const threadsById = new Map(threads.map((thread) => [thread.id, thread] as const));

  const threadSessionById: Record<string, ThreadSessionSlice> = {};
  const threadDiffsById: Record<string, ThreadDiffsSlice> = {};
  const threadPlansById: Record<string, ThreadPlansSlice> = {};
  const threadDesignById: Record<string, ThreadDesignSlice> = {};

  const threadWorkLogById: Record<string, WorkLogProjectionState> = {};
  const sidebarThreadsById: Record<string, ReturnType<typeof buildSidebarThreadSummary>> = {};
  const nextThreadDetailLoadedById: Record<string, boolean> = {};

  for (const { source, mapped } of mappedResults) {
    const threadId = mapped.thread.id;
    const isFullSnapshot = source === null;
    const detailLoaded = isFullSnapshot || state.threadDetailLoadedById[threadId] === true;
    threadSessionById[threadId] = mapped.sessionSlice;
    threadDiffsById[threadId] = isFullSnapshot
      ? mapped.diffsSlice
      : detailLoaded
        ? (state.threadDiffsById[threadId] ?? mapped.diffsSlice)
        : mapped.diffsSlice;
    threadPlansById[threadId] = isFullSnapshot
      ? mapped.plansSlice
      : detailLoaded
        ? (state.threadPlansById[threadId] ?? mapped.plansSlice)
        : mapped.plansSlice;
    threadDesignById[threadId] = isFullSnapshot
      ? {
          designArtifacts: state.threadDesignById[threadId]?.designArtifacts ?? [],
          designPendingOptions: mapped.designSlice.designPendingOptions,
        }
      : detailLoaded
        ? {
            designArtifacts: state.threadDesignById[threadId]?.designArtifacts ?? [],
            designPendingOptions: mapped.designSlice.designPendingOptions,
          }
        : mapped.designSlice;
    const resolvedThread = threadsById.get(threadId) ?? mapped.thread;
    if (isFullSnapshot || detailLoaded) {
      const bootstrappedWorkLog = bootstrapWorkLogProjectionState(resolvedThread.activities, {
        messages: resolvedThread.messages,
        latestTurn: mapped.sessionSlice.latestTurn,
      });
      threadWorkLogById[threadId] = isFullSnapshot
        ? bootstrappedWorkLog
        : (state.threadWorkLogById?.[threadId] ?? bootstrappedWorkLog);
    }
    nextThreadDetailLoadedById[threadId] = detailLoaded;
    sidebarThreadsById[threadId] = isFullSnapshot
      ? buildSidebarThreadSummary(
          resolvedThread,
          mapped.sessionSlice,
          threadPlansById[threadId],
          threadDesignById[threadId],
        )
      : mapSidebarThreadSummaryFromContract(source, mapped.sessionSlice);
  }

  const threadIdsByProjectId = buildThreadIdsByProjectId(threads);

  return {
    ...state,
    projects,
    threads,
    sidebarThreadsById,
    threadIdsByProjectId,
    threadWorkLogById,
    threadSessionById,
    threadDiffsById,
    threadPlansById,
    threadDesignById,
    streamingMessageByThreadId: {},
    threadDetailLoadedById: nextThreadDetailLoadedById,
    bootstrapComplete: true,
  };
}

// ── Main dispatcher ──────────────────────────────────────────────────

export function applyOrchestrationEvent(state: AppState, event: ForgeEvent): AppState {
  const next =
    handleProjectEvent(state, event) ??
    handleThreadLifecycleEvent(state, event) ??
    handleSessionEvent(state, event) ??
    handleMessageEvent(state, event) ??
    handleTurnEvent(state, event) ??
    handleDiffEvent(state, event) ??
    handleActivityEvent(state, event) ??
    handleDesignEvent(state, event) ??
    handleRevertEvent(state, event) ??
    handleNoopEvent(state, event) ??
    state;

  if (next === state) return state;

  // Rebuild sidebar for the affected thread.
  const threadId = (event.payload as { threadId?: string })?.threadId;
  if (threadId) return rebuildSidebarForThread(next, threadId);

  // Design events (request.resolved, request.stale) don't carry threadId —
  // find the affected thread by diffing the threads arrays or slice maps.
  for (let i = 0; i < next.threads.length; i++) {
    if (next.threads[i] !== state.threads[i]) {
      return rebuildSidebarForThread(next, next.threads[i]!.id);
    }
  }

  // Check design slice changes for events that only modify slices (no thread array change).
  if (next.threadDesignById !== state.threadDesignById) {
    for (const id of Object.keys(next.threadDesignById)) {
      if (next.threadDesignById[id] !== state.threadDesignById[id]) {
        return rebuildSidebarForThread(next, id);
      }
    }
  }

  return next;
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
