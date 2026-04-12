import { type ForgeEvent, type ProjectId, type ThreadId } from "@forgetools/contracts";
import type { OrchestrationReadModel } from "@forgetools/contracts";
import { create } from "zustand";
import {
  applyOrchestrationEvent,
  applyOrchestrationEvents,
  syncServerReadModel,
} from "./storeEventHandlers";
import { EMPTY_THREAD_IDS, EMPTY_THREADS, updateThreadState } from "./storeStateHelpers";
import type { Project, SidebarThreadSummary, Thread } from "./types";

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

// ── State mutators ───────────────────────────────────────────────────

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
