import { type ThreadId } from "@forgetools/contracts";
import type { SidebarThreadSummary } from "../types";
import { resolveThreadStatusPill, type ThreadStatusPill } from "./Sidebar.logic";

export const DEFAULT_SIDEBAR_TREE_MAX_DEPTH = 2;

export type SidebarTreeSortGroup = "needs-attention" | "running" | "paused" | "completed";

export interface SidebarTreeThread extends SidebarThreadSummary {
  lastVisitedAt?: string | undefined;
}

export interface SidebarTreeNode {
  thread: SidebarTreeThread;
  depth: number;
  children: SidebarTreeNode[];
  ownStatus: ThreadStatusPill;
  displayStatus: ThreadStatusPill;
  sortGroup: SidebarTreeSortGroup;
  latestActivityAt: string | null;
}

export interface SidebarTreeVisibleNode extends SidebarTreeNode {
  isExpanded: boolean;
  isExpandable: boolean;
}

const SORT_GROUP_PRIORITY: Record<SidebarTreeSortGroup, number> = {
  "needs-attention": 4,
  running: 3,
  paused: 2,
  completed: 1,
};

const PAUSED_STATUS_PILL: ThreadStatusPill = {
  label: "Paused",
  colorClass: "text-zinc-500 dark:text-zinc-400/80",
  dotClass: "bg-zinc-400 dark:bg-zinc-500/80",
  pulse: false,
};

const COMPLETED_STATUS_PILL: ThreadStatusPill = {
  label: "Completed",
  colorClass: "text-emerald-600 dark:text-emerald-300/90",
  dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
  pulse: false,
};

const FAILED_STATUS_PILL: ThreadStatusPill = {
  label: "Failed",
  colorClass: "text-rose-600 dark:text-rose-300/90",
  dotClass: "bg-rose-500 dark:bg-rose-300/90",
  pulse: false,
};

function toSortableTimestamp(iso: string | undefined | null): number {
  if (!iso) {
    return Number.NEGATIVE_INFINITY;
  }
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function resolveLatestActivityAt(
  thread: SidebarTreeThread,
  children: readonly SidebarTreeNode[],
): string | null {
  let latestActivityAt: string | null = thread.updatedAt ?? thread.createdAt ?? null;
  let latestTimestamp = toSortableTimestamp(latestActivityAt);

  for (const child of children) {
    const childTimestamp = toSortableTimestamp(child.latestActivityAt);
    if (childTimestamp > latestTimestamp) {
      latestTimestamp = childTimestamp;
      latestActivityAt = child.latestActivityAt;
    }
  }

  return latestActivityAt;
}

function resolveOwnTreeStatus(thread: SidebarTreeThread): ThreadStatusPill {
  const directStatus = resolveThreadStatusPill({ thread });
  if (directStatus !== null) {
    return directStatus;
  }
  if (thread.session?.status === "error") {
    return FAILED_STATUS_PILL;
  }
  if (thread.session?.status === "closed") {
    return COMPLETED_STATUS_PILL;
  }
  return PAUSED_STATUS_PILL;
}

function resolveSortGroupFromStatus(status: ThreadStatusPill): SidebarTreeSortGroup {
  switch (status.label) {
    case "Pending Approval":
    case "Awaiting Input":
    case "Plan Ready":
    case "Failed":
      return "needs-attention";
    case "Deliberating":
    case "Working":
    case "Connecting":
      return "running";
    case "Completed":
      return "completed";
    case "Paused":
      return "paused";
  }
}

function compareStatuses(left: ThreadStatusPill, right: ThreadStatusPill): number {
  const byGroupPriority =
    SORT_GROUP_PRIORITY[resolveSortGroupFromStatus(right)] -
    SORT_GROUP_PRIORITY[resolveSortGroupFromStatus(left)];
  if (byGroupPriority !== 0) {
    return byGroupPriority;
  }
  return 0;
}

function resolveDisplayStatus(
  ownStatus: ThreadStatusPill,
  children: readonly SidebarTreeNode[],
): ThreadStatusPill {
  if (children.length === 0) {
    return ownStatus;
  }

  const childStatus = children.map((child) => child.displayStatus).toSorted(compareStatuses)[0];

  if (!childStatus) {
    return ownStatus;
  }

  const ownGroup = resolveSortGroupFromStatus(ownStatus);
  const childGroup = resolveSortGroupFromStatus(childStatus);

  if (
    SORT_GROUP_PRIORITY[ownGroup] > SORT_GROUP_PRIORITY[childGroup] &&
    ownGroup !== "paused" &&
    ownGroup !== "completed"
  ) {
    return ownStatus;
  }

  return childStatus;
}

function compareTreeNodes(left: SidebarTreeNode, right: SidebarTreeNode): number {
  const byGroupPriority =
    SORT_GROUP_PRIORITY[right.sortGroup] - SORT_GROUP_PRIORITY[left.sortGroup];
  if (byGroupPriority !== 0) {
    return byGroupPriority;
  }

  const rightTimestamp = toSortableTimestamp(right.latestActivityAt);
  const leftTimestamp = toSortableTimestamp(left.latestActivityAt);
  if (rightTimestamp !== leftTimestamp) {
    return rightTimestamp > leftTimestamp ? 1 : -1;
  }

  return right.thread.id.localeCompare(left.thread.id);
}

export function buildSidebarThreadTree(input: {
  threads: readonly SidebarTreeThread[];
  maxDepth?: number;
}): SidebarTreeNode[] {
  const maxDepth = input.maxDepth ?? DEFAULT_SIDEBAR_TREE_MAX_DEPTH;
  const threadsById = new Map(input.threads.map((thread) => [thread.id, thread] as const));
  const childThreadIdsByParentId = new Map<ThreadId, ThreadId[]>();

  for (const thread of input.threads) {
    const parentThreadId = thread.parentThreadId ?? null;
    if (parentThreadId === null) {
      continue;
    }
    const parent = threadsById.get(parentThreadId);
    if (!parent) {
      continue;
    }
    const existing = childThreadIdsByParentId.get(parent.id) ?? [];
    childThreadIdsByParentId.set(parent.id, [...existing, thread.id]);
  }

  const buildNode = (thread: SidebarTreeThread, depth: number): SidebarTreeNode => {
    const childThreads =
      depth >= maxDepth
        ? []
        : (childThreadIdsByParentId.get(thread.id) ?? [])
            .map((threadId) => threadsById.get(threadId))
            .filter((child): child is SidebarTreeThread => child !== undefined)
            .map((child) => buildNode(child, depth + 1))
            .toSorted(compareTreeNodes);

    const ownStatus = resolveOwnTreeStatus(thread);
    const displayStatus = resolveDisplayStatus(ownStatus, childThreads);
    const latestActivityAt = resolveLatestActivityAt(thread, childThreads);

    return {
      thread,
      depth,
      children: childThreads,
      ownStatus,
      displayStatus,
      sortGroup: resolveSortGroupFromStatus(displayStatus),
      latestActivityAt,
    };
  };

  return input.threads
    .filter((thread) => {
      const parentThreadId = thread.parentThreadId ?? null;
      if (parentThreadId === null) {
        return true;
      }
      return !threadsById.has(parentThreadId);
    })
    .map((thread) => buildNode(thread, 0))
    .toSorted(compareTreeNodes);
}

export function flattenSidebarThreadTree(input: {
  nodes: readonly SidebarTreeNode[];
  expandedThreadIds?: ReadonlySet<ThreadId>;
}): SidebarTreeVisibleNode[] {
  const expandedThreadIds = input.expandedThreadIds ?? new Set<ThreadId>();
  const visibleNodes: SidebarTreeVisibleNode[] = [];

  const visitNode = (node: SidebarTreeNode) => {
    const isExpandable = node.children.length > 0;
    const isExpanded = isExpandable && expandedThreadIds.has(node.thread.id);
    visibleNodes.push({
      ...node,
      isExpanded,
      isExpandable,
    });

    if (!isExpanded) {
      return;
    }

    for (const child of node.children) {
      visitNode(child);
    }
  };

  for (const node of input.nodes) {
    visitNode(node);
  }

  return visibleNodes;
}

export function toggleSidebarTreeThreadExpansion(
  expandedThreadIds: ReadonlySet<ThreadId>,
  threadId: ThreadId,
): Set<ThreadId> {
  const next = new Set(expandedThreadIds);
  if (next.has(threadId)) {
    next.delete(threadId);
    return next;
  }
  next.add(threadId);
  return next;
}

export function syncExpandedSidebarTreeState(input: {
  nodes: readonly SidebarTreeNode[];
  expandedThreadIds: ReadonlySet<ThreadId>;
  activeThreadId: ThreadId | null;
}): Set<ThreadId> {
  const expandableThreadIds = new Set<ThreadId>();
  const parentThreadIdById = new Map<ThreadId, ThreadId | null>();

  const visitNode = (node: SidebarTreeNode) => {
    parentThreadIdById.set(node.thread.id, node.thread.parentThreadId ?? null);
    if (node.children.length > 0) {
      expandableThreadIds.add(node.thread.id);
    }
    for (const child of node.children) {
      visitNode(child);
    }
  };

  for (const node of input.nodes) {
    visitNode(node);
  }

  const nextExpandedThreadIds = new Set(
    [...input.expandedThreadIds].filter((threadId) => expandableThreadIds.has(threadId)),
  );

  const ancestorThreadIds: ThreadId[] = [];
  let ancestorThreadId = input.activeThreadId
    ? (parentThreadIdById.get(input.activeThreadId) ?? null)
    : null;
  while (ancestorThreadId !== null) {
    ancestorThreadIds.push(ancestorThreadId);
    ancestorThreadId = parentThreadIdById.get(ancestorThreadId) ?? null;
  }
  for (const threadId of ancestorThreadIds.toReversed()) {
    if (expandableThreadIds.has(threadId)) {
      nextExpandedThreadIds.add(threadId);
    }
  }

  return nextExpandedThreadIds;
}
