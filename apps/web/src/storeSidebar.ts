import {
  findLatestProposedPlan,
  hasActionableProposedPlan,
  isLatestTurnSettled,
} from "./session-logic";
import { hasPendingDesignChoice } from "./storeMappers";
import type {
  SidebarThreadSummary,
  Thread,
  ThreadDesignSlice,
  ThreadPlansSlice,
  ThreadSessionSlice,
} from "./types";

// ── Sidebar derivation helpers ───────────────────────────────────────

export function getLatestUserMessageAt(
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
 * Pre-computed attention flags, so that `buildSidebarThreadSummary` can share
 * them with `getLastSortableActivityAt` without re-deriving.
 */
interface AttentionFlags {
  hasPendingApprovals: boolean;
  hasPendingUserInputs: boolean;
  hasDesignChoice: boolean;
  hasProposedPlan: boolean;
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
function getLastSortableActivityAt(
  thread: Thread,
  sessionSlice: ThreadSessionSlice | undefined,
  attention: AttentionFlags,
): string | null {
  const candidates: string[] = [];

  const latestUserMsg = getLatestUserMessageAt(thread.messages);
  if (latestUserMsg !== null) {
    candidates.push(latestUserMsg);
  }

  const latestTurn = sessionSlice?.latestTurn ?? null;
  const session = sessionSlice?.session ?? null;
  if (latestTurn?.completedAt && isLatestTurnSettled(latestTurn, session)) {
    candidates.push(latestTurn.completedAt);
  }

  const needsAttention =
    attention.hasPendingApprovals ||
    attention.hasPendingUserInputs ||
    attention.hasDesignChoice ||
    attention.hasProposedPlan;
  if (needsAttention && thread.updatedAt) {
    candidates.push(thread.updatedAt);
  }

  if (candidates.length === 0) {
    return thread.updatedAt ?? thread.createdAt ?? null;
  }

  return candidates.reduce((a, b) => (a > b ? a : b));
}

/**
 * Builds a sidebar summary for a thread. The four attention-related flags
 * (`hasPendingApprovals`, `hasPendingUserInput`, `hasPendingDesignChoice`,
 * `hasActionableProposedPlan`) are each computed once, then forwarded to
 * `getLastSortableActivityAt` to avoid the previous double-computation.
 */
export function buildSidebarThreadSummary(
  thread: Thread,
  sessionSlice: ThreadSessionSlice | undefined,
  plansSlice: ThreadPlansSlice | undefined,
  designSlice: ThreadDesignSlice | undefined,
): SidebarThreadSummary {
  const pendingRequests = sessionSlice?.pendingRequests ?? [];
  const pendingApprovals = pendingRequests.some(
    (request) => request.type === "approval" && request.status === "pending",
  );
  const pendingUserInputs = pendingRequests.some(
    (request) =>
      request.status === "pending" &&
      request.type !== "approval" &&
      request.type !== "design-option",
  );
  const designChoice = hasPendingDesignChoice(designSlice);
  const latestTurn = sessionSlice?.latestTurn ?? null;
  const proposedPlan = hasActionableProposedPlan(
    findLatestProposedPlan(plansSlice?.proposedPlans ?? [], latestTurn?.turnId ?? null),
  );

  const lastSortableActivityAt = getLastSortableActivityAt(thread, sessionSlice, {
    hasPendingApprovals: pendingApprovals,
    hasPendingUserInputs: pendingUserInputs,
    hasDesignChoice: designChoice,
    hasProposedPlan: proposedPlan,
  });

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
    session: sessionSlice?.session ?? null,
    createdAt: thread.createdAt,
    pinnedAt: thread.pinnedAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    latestTurn,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    spawnBranch: thread.spawnBranch ?? null,
    spawnWorktreePath: thread.spawnWorktreePath ?? null,
    latestUserMessageAt: getLatestUserMessageAt(thread.messages),
    lastSortableActivityAt,
    hasPendingApprovals: pendingApprovals,
    hasPendingUserInput: pendingUserInputs,
    hasPendingDesignChoice: designChoice,
    hasActionableProposedPlan: proposedPlan,
    ...(thread.spawnMode !== undefined ? { spawnMode: thread.spawnMode } : {}),
  };
}

export function sidebarThreadSummariesEqual(
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

export function buildSidebarThreadsById(
  threads: ReadonlyArray<Thread>,
  sessionById: Record<string, ThreadSessionSlice>,
  plansById: Record<string, ThreadPlansSlice>,
  designById: Record<string, ThreadDesignSlice>,
): Record<string, SidebarThreadSummary> {
  return Object.fromEntries(
    threads.map((thread) => [
      thread.id,
      buildSidebarThreadSummary(
        thread,
        sessionById[thread.id],
        plansById[thread.id],
        designById[thread.id],
      ),
    ]),
  );
}
