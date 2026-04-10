import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectId, ThreadId } from "@forgetools/contracts";
import type { SidebarThreadSummary } from "../../types";
import { SidebarMenuSub, SidebarProvider } from "../ui/sidebar";
import { SidebarThreadRow, type SidebarThreadRowBindings } from "./SidebarThreadRow";
import type { SidebarTreeVisibleNode } from "../SidebarTree.logic";

let mockedThread: SidebarThreadSummary | undefined;

vi.mock("../../storeSelectors", () => ({
  useSidebarThreadSummaryById: () => mockedThread,
}));

vi.mock("../../uiStateStore", () => ({
  useUiStateStore: (
    selector: (state: { threadLastVisitedAtById: Record<string, string> }) => unknown,
  ) => selector({ threadLastVisitedAtById: {} }),
}));

vi.mock("../../terminalStateStore", () => ({
  selectThreadTerminalState: () => ({ runningTerminalIds: [], terminalOpen: false }),
  useTerminalStateStore: (
    selector: (state: { terminalStateByThreadId: Record<string, unknown> }) => unknown,
  ) => selector({ terminalStateByThreadId: {} }),
}));

afterEach(() => {
  mockedThread = undefined;
});

function makeThread(
  threadId: string,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
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
    createdAt: "2026-04-10T00:00:00.000Z",
    pinnedAt: null,
    archivedAt: null,
    updatedAt: "2026-04-10T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    lastSortableActivityAt: "2026-04-10T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasPendingDesignChoice: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeTreeNode(
  thread: SidebarThreadSummary,
  depth: number,
  overrides: Partial<SidebarTreeVisibleNode> = {},
): SidebarTreeVisibleNode {
  return {
    thread,
    depth,
    children: [],
    ownStatus: {
      kind: "paused",
      label: "Paused",
      colorClass: "text-muted-foreground",
      dotClass: "bg-muted-foreground",
      pulse: false,
      glowClass: null,
    },
    displayStatus: {
      kind: "paused",
      label: "Paused",
      colorClass: "text-muted-foreground",
      dotClass: "bg-muted-foreground",
      pulse: false,
      glowClass: null,
    },
    sortGroup: "paused",
    latestActivityAt: thread.lastSortableActivityAt,
    isExpanded: false,
    isExpandable: false,
    ...overrides,
  };
}

function makeBindings(): SidebarThreadRowBindings {
  return {
    orderedProjectThreadIds: [],
    routeThreadId: null,
    selectedThreadIds: new Set(),
    showThreadJumpHints: false,
    jumpLabelByThreadId: new Map(),
    appSettingsConfirmThreadArchive: false,
    renamingThreadId: null,
    renamingTitle: "",
    setRenamingTitle: () => undefined,
    renamingInputRef: { current: null },
    renamingCommittedRef: { current: false },
    confirmingArchiveThreadId: null,
    setConfirmingArchiveThreadId: () => undefined,
    confirmArchiveButtonRefs: { current: new Map() },
    handleThreadClick: () => undefined,
    navigateToThread: () => undefined,
    handleMultiSelectContextMenu: async () => undefined,
    handleThreadContextMenu: async () => undefined,
    clearSelection: () => undefined,
    commitRename: async () => undefined,
    cancelRename: () => undefined,
    attemptArchiveThread: async () => undefined,
    openPrLink: () => undefined,
    togglePinnedThread: async () => undefined,
    toggleTreeNodeExpansion: () => undefined,
    prByThreadId: new Map(),
  };
}

describe("SidebarThreadRow", () => {
  it("renders an active pin button for pinned root threads", () => {
    const thread = makeThread("thread-root", {
      pinnedAt: "2026-04-10T00:05:00.000Z",
    });
    mockedThread = thread;

    const markup = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarMenuSub>
          <SidebarThreadRow
            threadId={thread.id}
            treeNode={makeTreeNode(thread, 0)}
            bindings={makeBindings()}
          />
        </SidebarMenuSub>
      </SidebarProvider>,
    );

    expect(markup).toContain('data-testid="thread-pin-thread-root"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it("does not render a pin button for child threads", () => {
    const thread = makeThread("thread-child", {
      parentThreadId: ThreadId.makeUnsafe("thread-root"),
      pinnedAt: "2026-04-10T00:05:00.000Z",
    });
    mockedThread = thread;

    const markup = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarMenuSub>
          <SidebarThreadRow
            threadId={thread.id}
            treeNode={makeTreeNode(thread, 1)}
            bindings={makeBindings()}
          />
        </SidebarMenuSub>
      </SidebarProvider>,
    );

    expect(markup).not.toContain('data-testid="thread-pin-thread-child"');
  });
});
