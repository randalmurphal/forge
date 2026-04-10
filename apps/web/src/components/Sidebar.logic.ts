import * as React from "react";
import { resolveThreadSpawnWorkspace } from "@forgetools/shared/threadWorkspace";
import type {
  SidebarProjectSortOrder,
  SidebarThreadSortOrder,
} from "@forgetools/contracts/settings";
import type { SidebarThreadSummary, Thread } from "../types";
import { cn } from "../lib/utils";
import { isLatestTurnSettled } from "../session-logic";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 100;
export type SidebarNewThreadEnvMode = "local" | "worktree";
export type ThreadStatusSortGroup = "needs-attention" | "running" | "paused" | "completed";
export type ThreadStatusKind =
  | "pending-approval"
  | "awaiting-input"
  | "discussing"
  | "designing"
  | "planning"
  | "working"
  | "connecting"
  | "plan-ready"
  | "paused"
  | "completed"
  | "failed";
type SidebarProject = {
  id: string;
  name: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};
type SidebarThreadSortInput = Pick<Thread, "createdAt" | "updatedAt"> & {
  latestUserMessageAt?: string | null;
  lastSortableActivityAt?: string | null;
  messages?: Pick<Thread["messages"][number], "createdAt" | "role">[];
};

export type ThreadTraversalDirection = "previous" | "next";

export interface ThreadStatusPill {
  kind: ThreadStatusKind;
  label:
    | "Working"
    | "Planning"
    | "Designing"
    | "Discussing"
    | "Connecting"
    | "Completed"
    | "Paused"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready"
    | "Failed";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

const THREAD_STATUS_METADATA: Record<
  ThreadStatusKind,
  {
    label: ThreadStatusPill["label"];
    colorClass: string;
    dotClass: string;
    pulse: boolean;
    priority: number;
    sortGroup: ThreadStatusSortGroup;
  }
> = {
  failed: {
    label: "Failed",
    colorClass: "text-[var(--destructive-foreground)]",
    dotClass: "bg-[var(--destructive)]",
    pulse: false,
    priority: 100,
    sortGroup: "needs-attention",
  },
  "pending-approval": {
    label: "Pending Approval",
    colorClass: "text-[var(--warning-foreground)]",
    dotClass: "bg-[var(--warning)]",
    pulse: false,
    priority: 90,
    sortGroup: "needs-attention",
  },
  "awaiting-input": {
    label: "Awaiting Input",
    colorClass: "text-[var(--info-foreground)]",
    dotClass: "bg-[var(--info)]",
    pulse: false,
    priority: 80,
    sortGroup: "needs-attention",
  },
  discussing: {
    label: "Discussing",
    colorClass: "text-[var(--feature-phase-running)]",
    dotClass: "border border-[var(--feature-phase-running)] bg-transparent",
    pulse: false,
    priority: 75,
    sortGroup: "running",
  },
  designing: {
    label: "Designing",
    colorClass: "text-[var(--success-foreground)]",
    dotClass: "bg-[var(--success)]",
    pulse: true,
    priority: 74,
    sortGroup: "running",
  },
  planning: {
    label: "Planning",
    colorClass: "text-[var(--success-foreground)]",
    dotClass: "bg-[var(--success)]",
    pulse: true,
    priority: 73,
    sortGroup: "running",
  },
  working: {
    label: "Working",
    colorClass: "text-[var(--success-foreground)]",
    dotClass: "bg-[var(--success)]",
    pulse: true,
    priority: 72,
    sortGroup: "running",
  },
  connecting: {
    label: "Connecting",
    colorClass: "text-[var(--feature-phase-running)]",
    dotClass: "bg-[var(--feature-phase-running)]",
    pulse: true,
    priority: 71,
    sortGroup: "running",
  },
  "plan-ready": {
    label: "Plan Ready",
    colorClass: "text-[var(--primary)]",
    dotClass: "bg-[var(--primary)]",
    pulse: false,
    priority: 60,
    sortGroup: "needs-attention",
  },
  paused: {
    label: "Paused",
    colorClass: "text-[var(--feature-phase-pending)]",
    dotClass: "bg-[var(--feature-phase-pending)]",
    pulse: false,
    priority: 50,
    sortGroup: "paused",
  },
  completed: {
    label: "Completed",
    colorClass: "text-[var(--success-foreground)]",
    dotClass: "bg-[var(--success)]",
    pulse: false,
    priority: 40,
    sortGroup: "completed",
  },
};

type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasPendingDesignChoice"
  | "interactionMode"
  | "latestTurn"
  | "discussionId"
  | "role"
  | "session"
> & {
  lastVisitedAt?: string | undefined;
};

export interface ThreadJumpHintVisibilityController {
  sync: (shouldShow: boolean) => void;
  dispose: () => void;
}

export function createThreadJumpHintVisibilityController(input: {
  delayMs: number;
  onVisibilityChange: (visible: boolean) => void;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
}): ThreadJumpHintVisibilityController {
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout;
  let isVisible = false;
  let timeoutId: NodeJS.Timeout | null = null;

  const clearPendingShow = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeoutFn(timeoutId);
    timeoutId = null;
  };

  return {
    sync: (shouldShow) => {
      if (!shouldShow) {
        clearPendingShow();
        if (isVisible) {
          isVisible = false;
          input.onVisibilityChange(false);
        }
        return;
      }

      if (isVisible || timeoutId !== null) {
        return;
      }

      timeoutId = setTimeoutFn(() => {
        timeoutId = null;
        isVisible = true;
        input.onVisibilityChange(true);
      }, input.delayMs);
    },
    dispose: () => {
      clearPendingShow();
    },
  };
}

export function useThreadJumpHintVisibility(): {
  showThreadJumpHints: boolean;
  updateThreadJumpHintsVisibility: (shouldShow: boolean) => void;
} {
  const [showThreadJumpHints, setShowThreadJumpHints] = React.useState(false);
  const controllerRef = React.useRef<ThreadJumpHintVisibilityController | null>(null);

  React.useEffect(() => {
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        setShowThreadJumpHints(visible);
      },
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
    });
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const updateThreadJumpHintsVisibility = React.useCallback((shouldShow: boolean) => {
    controllerRef.current?.sync(shouldShow);
  }, []);

  return {
    showThreadJumpHints,
    updateThreadJumpHintsVisibility,
  };
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

export function resolveSidebarNewThreadEnvMode(input: {
  requestedEnvMode?: SidebarNewThreadEnvMode;
  defaultEnvMode: SidebarNewThreadEnvMode;
}): SidebarNewThreadEnvMode {
  return input.requestedEnvMode ?? input.defaultEnvMode;
}

export function resolveSidebarNewThreadSeedContext(input: {
  projectId: string;
  defaultEnvMode: SidebarNewThreadEnvMode;
  activeThread?: {
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
    spawnMode?: "local" | "worktree";
    spawnBranch?: string | null;
    spawnWorktreePath?: string | null;
  } | null;
  activeDraftThread?: {
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
    envMode: SidebarNewThreadEnvMode;
  } | null;
}): {
  branch?: string | null;
  worktreePath?: string | null;
  envMode: SidebarNewThreadEnvMode;
} {
  if (input.activeDraftThread?.projectId === input.projectId) {
    return {
      branch: input.activeDraftThread.branch,
      worktreePath: input.activeDraftThread.worktreePath,
      envMode: input.activeDraftThread.envMode,
    };
  }

  if (input.activeThread?.projectId === input.projectId) {
    const spawnWorkspace = resolveThreadSpawnWorkspace(input.activeThread);
    return {
      branch: spawnWorkspace.branch,
      worktreePath: spawnWorkspace.worktreePath,
      envMode: spawnWorkspace.mode,
    };
  }

  return {
    envMode: input.defaultEnvMode,
  };
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
}): TItem[] {
  const { getId, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const itemsById = new Map(items.map((item) => [getId(item), item] as const));
  const preferredIdSet = new Set(preferredIds);
  const emittedPreferredIds = new Set<TId>();
  const ordered = preferredIds.flatMap((id) => {
    if (emittedPreferredIds.has(id)) {
      return [];
    }
    const item = itemsById.get(id);
    if (!item) {
      return [];
    }
    emittedPreferredIds.add(id);
    return [item];
  });
  const remaining = items.filter((item) => !preferredIdSet.has(getId(item)));
  return [...ordered, ...remaining];
}

export function getVisibleSidebarThreadIds<TThreadId>(
  renderedProjects: readonly {
    shouldShowThreadPanel?: boolean;
    renderedThreadIds: readonly TThreadId[];
  }[],
): TThreadId[] {
  return renderedProjects.flatMap((renderedProject) =>
    renderedProject.shouldShowThreadPanel === false ? [] : renderedProject.renderedThreadIds,
  );
}

export function resolveAdjacentThreadId<T>(input: {
  threadIds: readonly T[];
  currentThreadId: T | null;
  direction: ThreadTraversalDirection;
}): T | null {
  const { currentThreadId, direction, threadIds } = input;

  if (threadIds.length === 0) {
    return null;
  }

  if (currentThreadId === null) {
    return direction === "previous" ? (threadIds.at(-1) ?? null) : (threadIds[0] ?? null);
  }

  const currentIndex = threadIds.indexOf(currentThreadId);
  if (currentIndex === -1) {
    return null;
  }

  if (direction === "previous") {
    return currentIndex > 0 ? (threadIds[currentIndex - 1] ?? null) : null;
  }

  return currentIndex < threadIds.length - 1 ? (threadIds[currentIndex + 1] ?? null) : null;
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
  multiLine?: boolean;
}): string {
  const baseClassName = `${input.multiLine ? "min-h-10 py-1" : "h-7"} w-full translate-x-0 cursor-pointer justify-start px-2 text-left select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring`;

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-primary/22 text-foreground font-medium hover:bg-primary/26 hover:text-foreground dark:bg-primary/30 dark:hover:bg-primary/36",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-primary/15 text-foreground hover:bg-primary/19 hover:text-foreground dark:bg-primary/22 dark:hover:bg-primary/28",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-accent/85 text-foreground font-medium hover:bg-accent hover:text-foreground dark:bg-accent/55 dark:hover:bg-accent/70",
    );
  }

  return cn(baseClassName, "text-muted-foreground hover:bg-accent hover:text-foreground");
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
}): ThreadStatusPill | null {
  const { thread } = input;

  if (thread.hasPendingApprovals) {
    return createThreadStatusPill("pending-approval");
  }

  if (thread.hasPendingUserInput || thread.hasPendingDesignChoice) {
    return createThreadStatusPill("awaiting-input");
  }

  if (thread.session?.status === "running") {
    return createThreadStatusPill(resolveRunningThreadStatusKind(thread));
  }

  if (thread.session?.status === "connecting") {
    return createThreadStatusPill("connecting");
  }

  if (thread.session?.status === "error") {
    return createThreadStatusPill("failed");
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    !thread.hasPendingDesignChoice &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return createThreadStatusPill("plan-ready");
  }

  if (hasUnseenCompletion(thread)) {
    return createThreadStatusPill("completed");
  }

  return null;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      getThreadStatusPriority(status) > getThreadStatusPriority(highestPriorityStatus)
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

function createThreadStatusPill(kind: ThreadStatusKind): ThreadStatusPill {
  const metadata = THREAD_STATUS_METADATA[kind];
  return {
    kind,
    label: metadata.label,
    colorClass: metadata.colorClass,
    dotClass: metadata.dotClass,
    pulse: metadata.pulse,
  };
}

function resolveRunningThreadStatusKind(thread: ThreadStatusInput): ThreadStatusKind {
  if (thread.discussionId != null || thread.role != null) {
    return "discussing";
  }
  if (thread.interactionMode === "design") {
    return "designing";
  }
  if (thread.interactionMode === "plan") {
    return "planning";
  }
  return "working";
}

export function getThreadStatusPriority(status: ThreadStatusPill): number {
  return THREAD_STATUS_METADATA[status.kind].priority;
}

export function getThreadStatusSortGroup(status: ThreadStatusPill): ThreadStatusSortGroup {
  return THREAD_STATUS_METADATA[status.kind].sortGroup;
}

export function getVisibleThreadsForProject<T extends Pick<Thread, "id">>(input: {
  threads: readonly T[];
  activeThreadId: T["id"] | undefined;
  pinnedThreadIds?: readonly T["id"][];
  isThreadListExpanded: boolean;
  previewLimit: number;
}): {
  hasHiddenThreads: boolean;
  visibleThreads: T[];
  hiddenThreads: T[];
} {
  const { activeThreadId, isThreadListExpanded, pinnedThreadIds, previewLimit, threads } = input;
  const hasHiddenThreads = threads.length > previewLimit;

  if (!hasHiddenThreads || isThreadListExpanded) {
    return {
      hasHiddenThreads,
      hiddenThreads: [],
      visibleThreads: [...threads],
    };
  }

  const previewThreads = threads.slice(0, previewLimit);
  const visibleThreadIds = new Set(previewThreads.map((thread) => thread.id));

  if (activeThreadId) {
    visibleThreadIds.add(activeThreadId);
  }

  for (const threadId of pinnedThreadIds ?? []) {
    visibleThreadIds.add(threadId);
  }

  return {
    hasHiddenThreads: true,
    hiddenThreads: threads.filter((thread) => !visibleThreadIds.has(thread.id)),
    visibleThreads: threads.filter((thread) => visibleThreadIds.has(thread.id)),
  };
}

function toSortableTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function getLatestUserMessageTimestamp(thread: SidebarThreadSortInput): number {
  if (thread.latestUserMessageAt) {
    return toSortableTimestamp(thread.latestUserMessageAt) ?? Number.NEGATIVE_INFINITY;
  }

  let latestUserMessageTimestamp: number | null = null;

  for (const message of thread.messages ?? []) {
    if (message.role !== "user") continue;
    const messageTimestamp = toSortableTimestamp(message.createdAt);
    if (messageTimestamp === null) continue;
    latestUserMessageTimestamp =
      latestUserMessageTimestamp === null
        ? messageTimestamp
        : Math.max(latestUserMessageTimestamp, messageTimestamp);
  }

  if (latestUserMessageTimestamp !== null) {
    return latestUserMessageTimestamp;
  }

  return (
    toSortableTimestamp(thread.lastSortableActivityAt ?? thread.updatedAt ?? thread.createdAt) ??
    Number.NEGATIVE_INFINITY
  );
}

function getThreadSortTimestamp(
  thread: SidebarThreadSortInput,
  sortOrder: SidebarThreadSortOrder | Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (sortOrder === "created_at") {
    return toSortableTimestamp(thread.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return getLatestUserMessageTimestamp(thread);
}

export function sortThreadsForSidebar<
  T extends Pick<Thread, "id" | "createdAt" | "updatedAt"> & SidebarThreadSortInput,
>(threads: readonly T[], sortOrder: SidebarThreadSortOrder): T[] {
  return threads.toSorted((left, right) => {
    const rightTimestamp = getThreadSortTimestamp(right, sortOrder);
    const leftTimestamp = getThreadSortTimestamp(left, sortOrder);
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) return byTimestamp;
    return right.id.localeCompare(left.id);
  });
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt"> & SidebarThreadSortInput,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreadsForSidebar(
      threads.filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}

export function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly SidebarThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends Pick<Thread, "projectId" | "createdAt" | "updatedAt"> & SidebarThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  return [...projects].toSorted((left, right) => {
    const rightTimestamp = getProjectSortTimestamp(
      right,
      threadsByProjectId.get(right.id) ?? [],
      sortOrder,
    );
    const leftTimestamp = getProjectSortTimestamp(
      left,
      threadsByProjectId.get(left.id) ?? [],
      sortOrder,
    );
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) return byTimestamp;
    return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
}
