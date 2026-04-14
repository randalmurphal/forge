import { type ForgeEvent, type ProjectId, type ThreadId } from "@forgetools/contracts";
import type { OrchestrationReadModel } from "@forgetools/contracts";
import { create } from "zustand";
import {
  applyOrchestrationEvent,
  applyOrchestrationEvents,
  syncServerReadModel,
} from "./storeEventHandlers";
import { EMPTY_THREAD_IDS, EMPTY_THREADS, updateThreadState } from "./storeStateHelpers";
import type {
  ChatMessage,
  Project,
  SidebarThreadSummary,
  Thread,
  ThreadDesignSlice,
  ThreadDiffsSlice,
  ThreadPlansSlice,
  ThreadSessionSlice,
} from "./types";
import type { WorkLogProjectionState } from "./session-logic";

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  sidebarThreadsById: Record<string, SidebarThreadSummary>;
  threadIdsByProjectId: Record<string, ThreadId[]>;
  threadWorkLogById?: Record<string, WorkLogProjectionState>;
  bootstrapComplete: boolean;

  // ── Normalized per-thread slices ────────────────────────────────────
  // Each slice isolates a high-churn concern so that mutations in one
  // (e.g. session status flips) don't trigger re-renders in components
  // that only consume another (e.g. the message list).
  threadSessionById: Record<string, ThreadSessionSlice>;
  threadDiffsById: Record<string, ThreadDiffsSlice>;
  threadPlansById: Record<string, ThreadPlansSlice>;
  threadDesignById: Record<string, ThreadDesignSlice>;
  streamingMessageByThreadId: Record<string, ChatMessage>;
}

const initialState: AppState = {
  projects: [],
  threads: [],
  sidebarThreadsById: {},
  threadIdsByProjectId: {},
  threadWorkLogById: {},
  bootstrapComplete: false,
  threadSessionById: {},
  threadDiffsById: {},
  threadPlansById: {},
  threadDesignById: {},
  streamingMessageByThreadId: {},
};

// ── Re-exports ───────────────────────────────────────────────────────
// The test suite and external consumers import these from "./store".

export { applyOrchestrationEvent, applyOrchestrationEvents, syncServerReadModel };

// ── Selectors ────────────────────────────────────────────────────────

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

export const selectThreadWorkLogById =
  (threadId: ThreadId | null | undefined) =>
  (state: AppState): WorkLogProjectionState | undefined =>
    threadId ? state.threadWorkLogById?.[threadId] : undefined;

export const selectThreadIdsByProjectId =
  (projectId: ProjectId | null | undefined) =>
  (state: AppState): ThreadId[] =>
    projectId ? (state.threadIdsByProjectId[projectId] ?? EMPTY_THREAD_IDS) : EMPTY_THREAD_IDS;

export const selectThreadSessionById =
  (threadId: ThreadId | null | undefined) =>
  (state: AppState): ThreadSessionSlice | undefined =>
    threadId ? state.threadSessionById[threadId] : undefined;

export const selectThreadDiffsById =
  (threadId: ThreadId | null | undefined) =>
  (state: AppState): ThreadDiffsSlice | undefined =>
    threadId ? state.threadDiffsById[threadId] : undefined;

export const selectThreadPlansById =
  (threadId: ThreadId | null | undefined) =>
  (state: AppState): ThreadPlansSlice | undefined =>
    threadId ? state.threadPlansById[threadId] : undefined;

export const selectThreadDesignById =
  (threadId: ThreadId | null | undefined) =>
  (state: AppState): ThreadDesignSlice | undefined =>
    threadId ? state.threadDesignById[threadId] : undefined;

export const selectStreamingMessageByThreadId =
  (threadId: ThreadId | null | undefined) =>
  (state: AppState): ChatMessage | undefined =>
    threadId ? state.streamingMessageByThreadId[threadId] : undefined;

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

// ── State mutators ───────────────────────────────────────────────────

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  const prev = state.threadSessionById[threadId];
  if (prev?.error === error) return state;
  return {
    ...state,
    threadSessionById: {
      ...state.threadSessionById,
      [threadId]: {
        session: prev?.session ?? null,
        latestTurn: prev?.latestTurn ?? null,
        error,
        pendingSourceProposedPlan: prev?.pendingSourceProposedPlan,
        pendingRequests: prev?.pendingRequests,
      },
    },
  };
}

export function setThreadBranch(
  state: AppState,
  threadId: ThreadId,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  let next = updateThreadState(state, threadId, (t) => {
    if (t.branch === branch && t.worktreePath === worktreePath) return t;
    return { ...t, branch, worktreePath };
  });
  // If the working directory changed, clear the session.
  const thread = next.threads.find((t) => t.id === threadId);
  if (
    thread &&
    thread.worktreePath !== state.threads.find((t) => t.id === threadId)?.worktreePath
  ) {
    const prev = next.threadSessionById[threadId];
    if (prev?.session !== null) {
      next = {
        ...next,
        threadSessionById: {
          ...next.threadSessionById,
          [threadId]: { ...prev!, session: null },
        },
      };
    }
  }
  return next;
}

// ── Zustand store ────────────────────────────────────────────────────

interface AppStore extends AppState {
  syncServerReadModel: (readModel: OrchestrationReadModel) => void;
  applyOrchestrationEvent: (event: ForgeEvent) => void;
  applyOrchestrationEvents: (events: ReadonlyArray<ForgeEvent>) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadBranch: (threadId: ThreadId, branch: string | null, worktreePath: string | null) => void;
  clearStreamingMessage: (threadId: ThreadId) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...initialState,
  syncServerReadModel: (readModel) => set((state) => syncServerReadModel(state, readModel)),
  applyOrchestrationEvent: (event) => set((state) => applyOrchestrationEvent(state, event)),
  applyOrchestrationEvents: (events) => set((state) => applyOrchestrationEvents(state, events)),
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setThreadBranch: (threadId, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadId, branch, worktreePath)),
  clearStreamingMessage: (threadId) =>
    set((state) => {
      if (!state.streamingMessageByThreadId[threadId]) return state;
      const { [threadId]: _, ...rest } = state.streamingMessageByThreadId;
      return { ...state, streamingMessageByThreadId: rest };
    }),
}));
