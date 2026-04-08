import { ProjectId, ThreadId } from "@forgetools/contracts";
import { describe, expect, it } from "vitest";
import type { SidebarThreadSummary } from "../types";
import {
  buildSidebarThreadTree,
  flattenSidebarThreadTree,
  syncExpandedSidebarTreeState,
  toggleSidebarTreeThreadExpansion,
} from "./SidebarTree.logic";

function makeThread(
  threadId: string,
  overrides: Partial<SidebarThreadSummary & { lastVisitedAt?: string | undefined }> = {},
): SidebarThreadSummary & { lastVisitedAt?: string | undefined } {
  return {
    id: ThreadId.makeUnsafe(threadId),
    projectId: ProjectId.makeUnsafe("project-1"),
    parentThreadId: null,
    phaseRunId: null,
    title: threadId,
    interactionMode: "default",
    workflowId: null,
    currentPhaseId: null,
    discussionId: null,
    role: null,
    childThreadIds: [],
    session: null,
    createdAt: "2026-04-06T00:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-04-06T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("buildSidebarThreadTree", () => {
  it("builds a bounded parent/child hierarchy from a flat thread list", () => {
    const root = makeThread("root", {
      childThreadIds: [ThreadId.makeUnsafe("child-1")],
    });
    const child = makeThread("child-1", {
      parentThreadId: root.id,
      childThreadIds: [ThreadId.makeUnsafe("grandchild-1")],
    });
    const grandchild = makeThread("grandchild-1", {
      parentThreadId: child.id,
      childThreadIds: [ThreadId.makeUnsafe("great-grandchild-1")],
    });
    const greatGrandchild = makeThread("great-grandchild-1", {
      parentThreadId: grandchild.id,
    });

    const tree = buildSidebarThreadTree({
      threads: [root, child, grandchild, greatGrandchild],
    });

    expect(tree).toHaveLength(1);
    expect(tree[0]?.thread.id).toBe(root.id);
    expect(tree[0]?.children[0]?.thread.id).toBe(child.id);
    expect(tree[0]?.children[0]?.children[0]?.thread.id).toBe(grandchild.id);
    expect(tree[0]?.children[0]?.children[0]?.children).toEqual([]);
  });

  it("propagates the highest-priority child status to parent containers", () => {
    const parent = makeThread("parent", {
      childThreadIds: [ThreadId.makeUnsafe("child-1"), ThreadId.makeUnsafe("child-2")],
    });
    const childNeedsAttention = makeThread("child-1", {
      parentThreadId: parent.id,
      hasPendingApprovals: true,
    });
    const childRunning = makeThread("child-2", {
      parentThreadId: parent.id,
      session: {
        provider: "codex",
        status: "running",
        activeTurnId: undefined,
        createdAt: "2026-04-06T00:00:00.000Z",
        updatedAt: "2026-04-06T00:00:00.000Z",
        orchestrationStatus: "running",
      },
    });

    const tree = buildSidebarThreadTree({
      threads: [parent, childNeedsAttention, childRunning],
    });

    expect(tree[0]?.sortGroup).toBe("needs-attention");
    expect(tree[0]?.displayStatus.label).toBe("Pending Approval");
  });

  it("sorts by status group priority and then most recent activity", () => {
    const pausedNewest = makeThread("paused-newest", {
      updatedAt: "2026-04-06T04:00:00.000Z",
    });
    const runningOlder = makeThread("running-older", {
      updatedAt: "2026-04-06T02:00:00.000Z",
      session: {
        provider: "codex",
        status: "running",
        activeTurnId: undefined,
        createdAt: "2026-04-06T00:00:00.000Z",
        updatedAt: "2026-04-06T02:00:00.000Z",
        orchestrationStatus: "running",
      },
    });
    const runningNewest = makeThread("running-newest", {
      updatedAt: "2026-04-06T03:00:00.000Z",
      session: {
        provider: "claudeAgent",
        status: "running",
        activeTurnId: undefined,
        createdAt: "2026-04-06T00:00:00.000Z",
        updatedAt: "2026-04-06T03:00:00.000Z",
        orchestrationStatus: "running",
      },
    });
    const completed = makeThread("completed", {
      updatedAt: "2026-04-06T05:00:00.000Z",
      session: {
        provider: "codex",
        status: "closed",
        activeTurnId: undefined,
        createdAt: "2026-04-06T00:00:00.000Z",
        updatedAt: "2026-04-06T05:00:00.000Z",
        orchestrationStatus: "stopped",
      },
    });
    const needsAttention = makeThread("needs-attention", {
      updatedAt: "2026-04-06T01:00:00.000Z",
      hasPendingUserInput: true,
    });

    const tree = buildSidebarThreadTree({
      threads: [pausedNewest, runningOlder, runningNewest, completed, needsAttention],
    });

    expect(tree.map((node) => node.thread.id)).toEqual([
      needsAttention.id,
      runningNewest.id,
      runningOlder.id,
      pausedNewest.id,
      completed.id,
    ]);
  });

  it("uses descendant activity when sorting parent containers", () => {
    const staleParent = makeThread("stale-parent", {
      updatedAt: "2026-04-06T01:00:00.000Z",
      childThreadIds: [ThreadId.makeUnsafe("active-child")],
    });
    const activeChild = makeThread("active-child", {
      parentThreadId: staleParent.id,
      updatedAt: "2026-04-06T05:00:00.000Z",
      session: {
        provider: "codex",
        status: "running",
        activeTurnId: undefined,
        createdAt: "2026-04-06T00:00:00.000Z",
        updatedAt: "2026-04-06T05:00:00.000Z",
        orchestrationStatus: "running",
      },
    });
    const newerOwnActivity = makeThread("newer-own-activity", {
      updatedAt: "2026-04-06T04:00:00.000Z",
      session: {
        provider: "claudeAgent",
        status: "running",
        activeTurnId: undefined,
        createdAt: "2026-04-06T00:00:00.000Z",
        updatedAt: "2026-04-06T04:00:00.000Z",
        orchestrationStatus: "running",
      },
    });

    const tree = buildSidebarThreadTree({
      threads: [staleParent, activeChild, newerOwnActivity],
    });

    expect(tree.map((node) => node.thread.id)).toEqual([staleParent.id, newerOwnActivity.id]);
    expect(tree[0]?.latestActivityAt).toBe(activeChild.updatedAt);
  });

  it("propagates deliberation status from running participants to their parent container", () => {
    const workflowParent = makeThread("workflow-parent", {
      childThreadIds: [ThreadId.makeUnsafe("participant-a"), ThreadId.makeUnsafe("participant-b")],
    });
    const participantA = makeThread("participant-a", {
      parentThreadId: workflowParent.id,
      role: "advocate",
      session: {
        provider: "claudeAgent",
        status: "running",
        activeTurnId: undefined,
        createdAt: "2026-04-06T00:00:00.000Z",
        updatedAt: "2026-04-06T04:00:00.000Z",
        orchestrationStatus: "running",
      },
    });
    const participantB = makeThread("participant-b", {
      parentThreadId: workflowParent.id,
      role: "interrogator",
      session: {
        provider: "codex",
        status: "running",
        activeTurnId: undefined,
        createdAt: "2026-04-06T00:00:00.000Z",
        updatedAt: "2026-04-06T04:05:00.000Z",
        orchestrationStatus: "running",
      },
    });

    const tree = buildSidebarThreadTree({
      threads: [workflowParent, participantA, participantB],
    });

    expect(tree[0]?.displayStatus.label).toBe("Deliberating");
    expect(tree[0]?.sortGroup).toBe("running");
  });
});

describe("sidebar tree expansion helpers", () => {
  it("toggles expansion state and flattens only expanded descendants", () => {
    const parent = makeThread("parent", {
      childThreadIds: [ThreadId.makeUnsafe("child-1")],
    });
    const child = makeThread("child-1", {
      parentThreadId: parent.id,
    });
    const tree = buildSidebarThreadTree({
      threads: [parent, child],
    });

    expect(flattenSidebarThreadTree({ nodes: tree }).map((node) => node.thread.id)).toEqual([
      parent.id,
    ]);

    const expanded = toggleSidebarTreeThreadExpansion(new Set<ThreadId>(), parent.id);

    expect(
      flattenSidebarThreadTree({
        nodes: tree,
        expandedThreadIds: expanded,
      }).map((node) => node.thread.id),
    ).toEqual([parent.id, child.id]);
  });

  it("keeps active-thread ancestors expanded", () => {
    const parent = makeThread("parent", {
      childThreadIds: [ThreadId.makeUnsafe("child-1")],
    });
    const child = makeThread("child-1", {
      parentThreadId: parent.id,
      childThreadIds: [ThreadId.makeUnsafe("grandchild-1")],
    });
    const grandchild = makeThread("grandchild-1", {
      parentThreadId: child.id,
    });

    const tree = buildSidebarThreadTree({
      threads: [parent, child, grandchild],
    });

    const expanded = syncExpandedSidebarTreeState({
      nodes: tree,
      expandedThreadIds: new Set<ThreadId>(),
      activeThreadId: grandchild.id,
    });

    expect([...expanded]).toEqual([parent.id, child.id]);
  });
});
