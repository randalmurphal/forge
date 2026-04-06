import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { GitStatusResult, ProjectId, ThreadId } from "@forgetools/contracts";
import type {
  SidebarProjectSortOrder,
  SidebarThreadSortOrder,
} from "@forgetools/contracts/settings";
import type { ServerConfig } from "@forgetools/contracts";
import { gitStatusQueryOptions } from "../../lib/gitReactQuery";
import type { Project, SidebarThreadSummary } from "../../types";
import {
  getVisibleSidebarThreadIds,
  getVisibleThreadsForProject,
  orderItemsByPreferredIds,
  resolveProjectStatusIndicator,
  sortProjectsForSidebar,
} from "../Sidebar.logic";
import {
  buildSidebarThreadTree,
  flattenSidebarThreadTree,
  syncExpandedSidebarTreeState,
  type SidebarTreeVisibleNode,
} from "../SidebarTree.logic";
import { shortcutLabelForCommand, threadJumpCommandForIndex } from "../../keybindings";

type SidebarProjectSnapshot = Project & {
  expanded: boolean;
};

type ThreadPr = GitStatusResult["pr"];

const THREAD_PREVIEW_LIMIT = 6;

export interface RenderedSidebarProject {
  hasHiddenThreads: boolean;
  hiddenThreadStatus: ReturnType<typeof resolveProjectStatusIndicator>;
  orderedProjectThreadIds: readonly ThreadId[];
  project: SidebarProjectSnapshot;
  projectStatus: ReturnType<typeof resolveProjectStatusIndicator>;
  renderedTreeNodes: readonly SidebarTreeVisibleNode[];
  renderedThreadIds: readonly ThreadId[];
  showEmptyThreadState: boolean;
  shouldShowThreadPanel: boolean;
  isThreadListExpanded: boolean;
}

export function useSidebarData(input: {
  projects: readonly Project[];
  sidebarThreadsById: Record<ThreadId, SidebarThreadSummary>;
  threadIdsByProjectId: Partial<Record<ProjectId, readonly ThreadId[]>>;
  projectExpandedById: Record<ProjectId, boolean | undefined>;
  projectOrder: readonly ProjectId[];
  threadLastVisitedAtById: Record<ThreadId, string | undefined>;
  routeThreadId: ThreadId | null;
  expandedThreadListsByProject: ReadonlySet<ProjectId>;
  expandedSidebarTreeThreadIds: ReadonlySet<ThreadId>;
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  keybindings: ServerConfig["keybindings"];
  sidebarShortcutLabelOptions: {
    platform: string;
    context: {
      terminalFocus: boolean;
      terminalOpen: boolean;
    };
  };
}) {
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: input.projects,
      preferredIds: input.projectOrder,
      getId: (project) => project.id,
    });
  }, [input.projectOrder, input.projects]);

  const sidebarProjects = useMemo<SidebarProjectSnapshot[]>(
    () =>
      orderedProjects.map((project) => ({
        ...project,
        expanded: input.projectExpandedById[project.id] ?? true,
      })),
    [input.projectExpandedById, orderedProjects],
  );

  const sidebarThreads = useMemo(
    () => Object.values(input.sidebarThreadsById),
    [input.sidebarThreadsById],
  );

  const projectCwdById = useMemo(
    () => new Map(input.projects.map((project) => [project.id, project.cwd] as const)),
    [input.projects],
  );

  const threadGitTargets = useMemo(
    () =>
      sidebarThreads.map((thread) => ({
        threadId: thread.id,
        branch: thread.branch,
        cwd: thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null,
      })),
    [projectCwdById, sidebarThreads],
  );

  const threadGitStatusCwds = useMemo(
    () => [
      ...new Set(
        threadGitTargets
          .filter((target) => target.branch !== null)
          .map((target) => target.cwd)
          .filter((cwd): cwd is string => cwd !== null),
      ),
    ],
    [threadGitTargets],
  );

  const threadGitStatusQueries = useQueries({
    queries: threadGitStatusCwds.map((cwd) => ({
      ...gitStatusQueryOptions(cwd),
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });

  const prByThreadId = useMemo(() => {
    const statusByCwd = new Map<string, GitStatusResult>();
    for (let index = 0; index < threadGitStatusCwds.length; index += 1) {
      const cwd = threadGitStatusCwds[index];
      if (!cwd) continue;
      const status = threadGitStatusQueries[index]?.data;
      if (status) {
        statusByCwd.set(cwd, status);
      }
    }

    const map = new Map<ThreadId, ThreadPr>();
    for (const target of threadGitTargets) {
      const status = target.cwd ? statusByCwd.get(target.cwd) : undefined;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      map.set(target.threadId, branchMatches ? (status?.pr ?? null) : null);
    }
    return map;
  }, [threadGitStatusCwds, threadGitStatusQueries, threadGitTargets]);

  const visibleThreads = useMemo(
    () => sidebarThreads.filter((thread) => thread.archivedAt === null),
    [sidebarThreads],
  );

  const sortedProjects = useMemo(
    () => sortProjectsForSidebar(sidebarProjects, visibleThreads, input.projectSortOrder),
    [input.projectSortOrder, sidebarProjects, visibleThreads],
  );

  const renderedProjects = useMemo<RenderedSidebarProject[]>(
    () =>
      sortedProjects.map((project) => {
        const projectThreads = (input.threadIdsByProjectId[project.id] ?? [])
          .map((threadId) => input.sidebarThreadsById[threadId])
          .filter((thread): thread is NonNullable<typeof thread> => thread !== undefined)
          .filter((thread) => thread.archivedAt === null);
        const treeNodes = buildSidebarThreadTree({
          threads: projectThreads.map((thread) =>
            Object.assign({}, thread, {
              lastVisitedAt: input.threadLastVisitedAtById[thread.id],
            }),
          ),
        });
        const activeThreadId = input.routeThreadId ?? undefined;
        const isThreadListExpanded = input.expandedThreadListsByProject.has(project.id);
        const effectiveExpandedTreeThreadIds = syncExpandedSidebarTreeState({
          nodes: treeNodes,
          expandedThreadIds: input.expandedSidebarTreeThreadIds,
          activeThreadId: input.routeThreadId,
        });
        const flatTreeNodes = flattenSidebarThreadTree({
          nodes: treeNodes,
          expandedThreadIds: effectiveExpandedTreeThreadIds,
        });
        const previewTreeNodes = flatTreeNodes.map((node) => ({
          id: node.thread.id,
          node,
        }));
        const projectStatus = resolveProjectStatusIndicator(
          treeNodes.map((node) => node.displayStatus),
        );
        const pinnedCollapsedThread =
          !project.expanded && activeThreadId
            ? (flatTreeNodes.find((node) => node.thread.id === activeThreadId) ?? null)
            : null;
        const shouldShowThreadPanel = project.expanded || pinnedCollapsedThread !== null;
        const {
          hasHiddenThreads,
          hiddenThreads,
          visibleThreads: visibleProjectTreeNodes,
        } = getVisibleThreadsForProject({
          threads: previewTreeNodes,
          activeThreadId,
          isThreadListExpanded,
          previewLimit: THREAD_PREVIEW_LIMIT,
        });
        const hiddenProjectTreeNodes = hiddenThreads.map((entry) => entry.node);
        const hiddenThreadStatus = resolveProjectStatusIndicator(
          hiddenProjectTreeNodes.map((node) => node.displayStatus),
        );
        const orderedProjectThreadIds = flatTreeNodes.map((node) => node.thread.id);
        const renderedTreeNodes = pinnedCollapsedThread
          ? [pinnedCollapsedThread]
          : visibleProjectTreeNodes.map((entry) => entry.node);
        const renderedThreadIds = renderedTreeNodes.map((node) => node.thread.id);
        const showEmptyThreadState = project.expanded && treeNodes.length === 0;

        return {
          hasHiddenThreads,
          hiddenThreadStatus,
          orderedProjectThreadIds,
          project,
          projectStatus,
          renderedTreeNodes,
          renderedThreadIds,
          showEmptyThreadState,
          shouldShowThreadPanel,
          isThreadListExpanded,
        };
      }),
    [
      input.expandedSidebarTreeThreadIds,
      input.expandedThreadListsByProject,
      input.routeThreadId,
      input.sidebarThreadsById,
      input.threadIdsByProjectId,
      input.threadLastVisitedAtById,
      sortedProjects,
    ],
  );

  const visibleSidebarThreadIds = useMemo(
    () => getVisibleSidebarThreadIds(renderedProjects),
    [renderedProjects],
  );

  const threadJumpCommandById = useMemo(() => {
    const mapping = new Map<ThreadId, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadId] of visibleSidebarThreadIds.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(threadId, jumpCommand);
    }

    return mapping;
  }, [visibleSidebarThreadIds]);

  const threadJumpThreadIds = useMemo(
    () => [...threadJumpCommandById.keys()],
    [threadJumpCommandById],
  );

  const threadJumpLabelById = useMemo(() => {
    const mapping = new Map<ThreadId, string>();
    for (const [threadId, command] of threadJumpCommandById) {
      const label = shortcutLabelForCommand(
        input.keybindings,
        command,
        input.sidebarShortcutLabelOptions,
      );
      if (label) {
        mapping.set(threadId, label);
      }
    }
    return mapping;
  }, [input.keybindings, input.sidebarShortcutLabelOptions, threadJumpCommandById]);

  return {
    projectCwdById,
    prByThreadId,
    renderedProjects,
    threadJumpLabelById,
    threadJumpThreadIds,
    visibleSidebarThreadIds,
  };
}
