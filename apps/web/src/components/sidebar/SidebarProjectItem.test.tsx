import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectId, ThreadId } from "@forgetools/contracts";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarProjectItem } from "./SidebarProjectItem";
import type { RenderedSidebarProject } from "./useSidebarData";
import type { SidebarThreadRowBindings } from "./SidebarThreadRow";
import type { SidebarTreeVisibleNode } from "../SidebarTree.logic";

function makeTreeNode(threadId: string, pinnedAt: string | null): SidebarTreeVisibleNode {
  return {
    thread: {
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
      pinnedAt,
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
    },
    depth: 0,
    children: [],
    ownStatus: {
      kind: "paused",
      label: "Paused",
      colorClass: "text-muted-foreground",
      dotClass: "bg-muted-foreground",
      pulse: false,
    },
    displayStatus: {
      kind: "paused",
      label: "Paused",
      colorClass: "text-muted-foreground",
      dotClass: "bg-muted-foreground",
      pulse: false,
    },
    sortGroup: "paused",
    latestActivityAt: "2026-04-10T00:00:00.000Z",
    isExpanded: false,
    isExpandable: false,
  };
}

function makeBindings(): Omit<
  SidebarThreadRowBindings,
  | "orderedProjectThreadIds"
  | "routeThreadId"
  | "selectedThreadIds"
  | "showThreadJumpHints"
  | "jumpLabelByThreadId"
  | "appSettingsConfirmThreadArchive"
  | "prByThreadId"
> {
  return {
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
  };
}

function makeRenderedProject(showPinnedSeparator: boolean): RenderedSidebarProject {
  const pinnedNode = makeTreeNode("thread-pinned", "2026-04-10T00:05:00.000Z");
  const unpinnedNode = makeTreeNode("thread-unpinned", null);
  return {
    hasHiddenThreads: false,
    hiddenThreadStatus: null,
    orderedProjectThreadIds: [pinnedNode.thread.id, unpinnedNode.thread.id],
    project: {
      id: ProjectId.makeUnsafe("project-1"),
      name: "Project",
      cwd: "/tmp/project-1",
      defaultModelSelection: null,
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:00:00.000Z",
      scripts: [],
      expanded: true,
    },
    projectStatus: null,
    pinnedRenderedTreeNodes: [pinnedNode],
    renderedTreeNodes: [pinnedNode, unpinnedNode],
    renderedThreadIds: [pinnedNode.thread.id, unpinnedNode.thread.id],
    showEmptyThreadState: false,
    showPinnedSeparator,
    shouldShowThreadPanel: true,
    isThreadListExpanded: false,
    unpinnedRenderedTreeNodes: [unpinnedNode],
  };
}

describe("SidebarProjectItem", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getWsUrl: () => "",
        },
        location: {
          origin: "http://localhost:3000",
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("renders the pinned separator only when both sections are present", () => {
    const withSeparator = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarProjectItem
          renderedProject={makeRenderedProject(true)}
          isManualProjectSorting={false}
          dragHandleProps={null}
          routeThreadId={null}
          selectedThreadIds={new Set()}
          showThreadJumpHints={false}
          jumpLabelByThreadId={new Map()}
          appSettingsConfirmThreadArchive={false}
          defaultThreadEnvMode="local"
          activeThreadSeed={null}
          activeDraftThreadSeed={null}
          newThreadShortcutLabel={null}
          threadRowBindings={makeBindings()}
          onProjectClick={() => undefined}
          onProjectKeyDown={() => undefined}
          onProjectContextMenu={() => undefined}
          onProjectTitlePointerDownCapture={() => undefined}
          onCreateThread={() => undefined}
          onExpandThreadList={() => undefined}
          onCollapseThreadList={() => undefined}
          onToggleTreeNodeExpansion={() => undefined}
          prByThreadId={new Map()}
        />
      </SidebarProvider>,
    );
    const withoutSeparator = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarProjectItem
          renderedProject={{ ...makeRenderedProject(false), unpinnedRenderedTreeNodes: [] }}
          isManualProjectSorting={false}
          dragHandleProps={null}
          routeThreadId={null}
          selectedThreadIds={new Set()}
          showThreadJumpHints={false}
          jumpLabelByThreadId={new Map()}
          appSettingsConfirmThreadArchive={false}
          defaultThreadEnvMode="local"
          activeThreadSeed={null}
          activeDraftThreadSeed={null}
          newThreadShortcutLabel={null}
          threadRowBindings={makeBindings()}
          onProjectClick={() => undefined}
          onProjectKeyDown={() => undefined}
          onProjectContextMenu={() => undefined}
          onProjectTitlePointerDownCapture={() => undefined}
          onCreateThread={() => undefined}
          onExpandThreadList={() => undefined}
          onCollapseThreadList={() => undefined}
          onToggleTreeNodeExpansion={() => undefined}
          prByThreadId={new Map()}
        />
      </SidebarProvider>,
    );

    expect(withSeparator).toContain('data-slot="sidebar-separator"');
    expect(withoutSeparator).not.toContain('data-slot="sidebar-separator"');
  });
});
