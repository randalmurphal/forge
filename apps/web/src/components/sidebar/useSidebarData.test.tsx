import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectId, ThreadId, type ServerConfig } from "@forgetools/contracts";
import type { SidebarThreadSummary } from "../../types";
import { useSidebarData, type RenderedSidebarProject } from "./useSidebarData";

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
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("useSidebarData", () => {
  it("keeps pinned root threads above preview-truncated unpinned threads", () => {
    const pinnedThread = makeThread("thread-pinned", {
      pinnedAt: "2026-04-10T00:01:00.000Z",
      lastSortableActivityAt: "2026-04-10T00:01:00.000Z",
    });
    const unpinnedThreads = Array.from({ length: 7 }, (_, index) =>
      makeThread(`thread-unpinned-${index + 1}`, {
        lastSortableActivityAt: `2026-04-10T00:0${9 - index}:00.000Z`,
        updatedAt: `2026-04-10T00:0${9 - index}:00.000Z`,
      }),
    );
    const sidebarThreads = [pinnedThread, ...unpinnedThreads];
    let renderedProjects: readonly RenderedSidebarProject[] = [];

    function Capture() {
      renderedProjects = useSidebarData({
        projects: [
          {
            id: ProjectId.makeUnsafe("project-1"),
            name: "Project",
            cwd: "/tmp/project-1",
            defaultModelSelection: null,
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:00:00.000Z",
            scripts: [],
          },
        ],
        sidebarThreadsById: Object.fromEntries(
          sidebarThreads.map((thread) => [thread.id, thread] as const),
        ),
        threadIdsByProjectId: {
          [ProjectId.makeUnsafe("project-1")]: sidebarThreads.map((thread) => thread.id),
        },
        projectExpandedById: {
          [ProjectId.makeUnsafe("project-1")]: true,
        },
        projectOrder: [ProjectId.makeUnsafe("project-1")],
        threadLastVisitedAtById: {},
        routeThreadId: null,
        expandedThreadListsByProject: new Set(),
        expandedSidebarTreeThreadIds: new Set(),
        projectSortOrder: "updated_at",
        threadSortOrder: "updated_at",
        keybindings: [] as ServerConfig["keybindings"],
        sidebarShortcutLabelOptions: {
          platform: "MacIntel",
          context: {
            terminalFocus: false,
            terminalOpen: false,
          },
        },
      }).renderedProjects;

      return null;
    }

    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <Capture />
      </QueryClientProvider>,
    );

    expect(renderedProjects).toHaveLength(1);
    expect(renderedProjects[0]?.pinnedRenderedTreeNodes.map((node) => node.thread.id)).toEqual([
      pinnedThread.id,
    ]);
    expect(renderedProjects[0]?.unpinnedRenderedTreeNodes).toHaveLength(6);
    expect(renderedProjects[0]?.unpinnedRenderedTreeNodes[0]?.thread.id).toBe(
      ThreadId.makeUnsafe("thread-unpinned-1"),
    );
    expect(renderedProjects[0]?.renderedThreadIds).toHaveLength(7);
    expect(renderedProjects[0]?.renderedThreadIds[0]).toBe(pinnedThread.id);
    expect(renderedProjects[0]?.hasHiddenThreads).toBe(true);
    expect(renderedProjects[0]?.showPinnedSeparator).toBe(true);
  });
});
