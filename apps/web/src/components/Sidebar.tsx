import { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ProjectId, ThreadId } from "@forgetools/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { isElectron } from "../env";
import { useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useUiStateStore } from "../uiStateStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useThreadActions } from "../hooks/useThreadActions";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "../rpc/serverState";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import { SidebarBrand } from "./sidebar/SidebarBrand";
import { SidebarDesktopUpdateBanner } from "./sidebar/SidebarDesktopUpdateBanner";
import { SidebarFooterNav } from "./sidebar/SidebarFooterNav";
import { SidebarProjectsSection } from "./sidebar/SidebarProjectsSection";
import { useSidebarData } from "./sidebar/useSidebarData";
import { useSidebarInteractions } from "./sidebar/useSidebarInteractions";
import { useThreadJumpHintVisibility } from "./Sidebar.logic";
import { SidebarContent, SidebarSeparator } from "./ui/sidebar";
import { shortcutLabelForCommand } from "../keybindings";

export default function Sidebar() {
  const projects = useStore((store) => store.projects);
  const sidebarThreadsById = useStore((store) => store.sidebarThreadsById);
  const threadIdsByProjectId = useStore((store) => store.threadIdsByProjectId);
  const { projectExpandedById, projectOrder, threadLastVisitedAtById } = useUiStateStore(
    useShallow((store) => ({
      projectExpandedById: store.projectExpandedById,
      projectOrder: store.projectOrder,
      threadLastVisitedAtById: store.threadLastVisitedAtById,
    })),
  );
  const markThreadUnread = useUiStateStore((store) => store.markThreadUnread);
  const toggleProject = useUiStateStore((store) => store.toggleProject);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const isOnSettings = pathname.startsWith("/settings");
  const appSettings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const { activeDraftThread, activeThread, handleNewThread } = useHandleNewThread();
  const { archiveThread, deleteThread } = useThreadActions();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const keybindings = useServerKeybindings();
  const selectedThreadIds = useThreadSelectionStore((state) => state.selectedThreadIds);
  const toggleThreadSelection = useThreadSelectionStore((state) => state.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((state) => state.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const removeFromSelection = useThreadSelectionStore((state) => state.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((state) => state.setAnchor);
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<ProjectId>
  >(() => new Set());
  const [expandedSidebarTreeThreadIds, setExpandedSidebarTreeThreadIds] = useState<
    ReadonlySet<ThreadId>
  >(() => new Set());

  const routeTerminalOpen = routeThreadId
    ? selectThreadTerminalState(terminalStateByThreadId, routeThreadId).terminalOpen
    : false;
  const platform = navigator.platform;
  const sidebarShortcutLabelOptions = useMemo(
    () => ({
      platform,
      context: {
        terminalFocus: false,
        terminalOpen: routeTerminalOpen,
      },
    }),
    [platform, routeTerminalOpen],
  );

  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );

  const sidebarData = useSidebarData({
    projects,
    sidebarThreadsById,
    threadIdsByProjectId,
    projectExpandedById,
    projectOrder,
    threadLastVisitedAtById,
    routeThreadId,
    expandedThreadListsByProject,
    expandedSidebarTreeThreadIds,
    projectSortOrder: appSettings.sidebarProjectSortOrder,
    threadSortOrder: appSettings.sidebarThreadSortOrder,
    keybindings,
    sidebarShortcutLabelOptions,
  });

  const threadActions = useSidebarInteractions({
    projects,
    sidebarThreadsById,
    threadIdsByProjectId,
    projectCwdById,
    selectedThreadIds,
    markThreadUnread,
    toggleProject,
    reorderProjects,
    clearComposerDraftForThread,
    getDraftThreadByProjectId,
    clearProjectDraftThreadId,
    navigate,
    archiveThread,
    deleteThread,
    handleNewThread,
    routeThreadId,
    routeTerminalOpen,
    platform,
    keybindings,
    orderedSidebarThreadIds: sidebarData.visibleSidebarThreadIds,
    threadJumpThreadIds: sidebarData.threadJumpThreadIds,
    updateThreadJumpHintsVisibility,
    toggleThreadSelection,
    rangeSelectTo,
    clearSelection,
    removeFromSelection,
    setSelectionAnchor,
    expandedThreadListsByProject,
    setExpandedThreadListsByProject,
    expandedSidebarTreeThreadIds,
    setExpandedSidebarTreeThreadIds,
    confirmThreadDelete: appSettings.confirmThreadDelete,
    confirmThreadArchive: appSettings.confirmThreadArchive,
    defaultThreadEnvMode: appSettings.defaultThreadEnvMode,
    sidebarProjectSortOrder: appSettings.sidebarProjectSortOrder,
    sidebarThreadSortOrder: appSettings.sidebarThreadSortOrder,
  });

  const activeThreadSeed =
    activeThread && activeThread.projectId
      ? {
          projectId: activeThread.projectId,
          branch: activeThread.branch,
          worktreePath: activeThread.worktreePath,
          spawnMode: activeThread.spawnMode,
          spawnBranch: activeThread.spawnBranch,
          spawnWorktreePath: activeThread.spawnWorktreePath,
        }
      : null;
  const activeDraftThreadSeed =
    activeDraftThread && activeDraftThread.projectId
      ? {
          projectId: activeDraftThread.projectId,
          branch: activeDraftThread.branch,
          worktreePath: activeDraftThread.worktreePath,
          envMode: activeDraftThread.envMode,
        }
      : null;
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal", sidebarShortcutLabelOptions) ??
    shortcutLabelForCommand(keybindings, "chat.new", sidebarShortcutLabelOptions);

  const createThread = useCallback(
    (
      projectId: ProjectId,
      input: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode: "local" | "worktree";
      },
    ) => {
      void handleNewThread(projectId, input);
    },
    [handleNewThread],
  );

  if (isOnSettings) {
    return (
      <>
        <SidebarBrand isElectron={isElectron} />
        <SettingsSidebarNav pathname={pathname} />
      </>
    );
  }

  return (
    <>
      <SidebarBrand isElectron={isElectron} />
      <SidebarContent className="gap-0">
        <SidebarDesktopUpdateBanner />
        <SidebarProjectsSection
          isElectron={isElectron}
          projectsCount={projects.length}
          renderedProjects={sidebarData.renderedProjects}
          isManualProjectSorting={appSettings.sidebarProjectSortOrder === "manual"}
          projectSortOrder={appSettings.sidebarProjectSortOrder}
          threadSortOrder={appSettings.sidebarThreadSortOrder}
          shouldShowProjectPathEntry={threadActions.shouldShowProjectPathEntry}
          isPickingFolder={threadActions.isPickingFolder}
          isAddingProject={threadActions.isAddingProject}
          addProjectError={threadActions.addProjectError}
          newCwd={threadActions.newCwd}
          canAddProject={threadActions.canAddProject}
          addProjectInputRef={threadActions.addProjectInputRef}
          routeThreadId={routeThreadId}
          selectedThreadIds={selectedThreadIds}
          showThreadJumpHints={showThreadJumpHints}
          jumpLabelByThreadId={sidebarData.threadJumpLabelById}
          appSettingsConfirmThreadArchive={appSettings.confirmThreadArchive}
          defaultThreadEnvMode={appSettings.defaultThreadEnvMode}
          activeThreadSeed={activeThreadSeed}
          activeDraftThreadSeed={activeDraftThreadSeed}
          newThreadShortcutLabel={newThreadShortcutLabel}
          threadRowBindings={{
            renamingThreadId: threadActions.renamingThreadId,
            renamingTitle: threadActions.renamingTitle,
            setRenamingTitle: threadActions.setRenamingTitle,
            renamingInputRef: threadActions.renamingInputRef,
            renamingCommittedRef: threadActions.renamingCommittedRef,
            confirmingArchiveThreadId: threadActions.confirmingArchiveThreadId,
            setConfirmingArchiveThreadId: threadActions.setConfirmingArchiveThreadId,
            confirmArchiveButtonRefs: threadActions.confirmArchiveButtonRefs,
            handleThreadClick: threadActions.handleThreadClick,
            navigateToThread: threadActions.navigateToThread,
            handleMultiSelectContextMenu: threadActions.handleMultiSelectContextMenu,
            handleThreadContextMenu: threadActions.handleThreadContextMenu,
            clearSelection,
            commitRename: threadActions.commitRename,
            cancelRename: threadActions.cancelRename,
            attemptArchiveThread: threadActions.attemptArchiveThread,
            openPrLink: threadActions.openPrLink,
            toggleTreeNodeExpansion: threadActions.toggleSidebarTreeExpansion,
          }}
          prByThreadId={sidebarData.prByThreadId}
          onProjectSortOrderChange={(sortOrder) => {
            updateSettings({ sidebarProjectSortOrder: sortOrder });
          }}
          onThreadSortOrderChange={(sortOrder) => {
            updateSettings({ sidebarThreadSortOrder: sortOrder });
          }}
          onStartAddProject={threadActions.handleStartAddProject}
          onPickFolder={() => {
            void threadActions.handlePickFolder();
          }}
          onNewCwdChange={(cwd) => {
            threadActions.setNewCwd(cwd);
            threadActions.setAddProjectError(null);
          }}
          onSubmitAddProject={threadActions.handleAddProject}
          onCancelAddProject={threadActions.cancelAddProject}
          onProjectClick={threadActions.handleProjectTitleClick}
          onProjectKeyDown={threadActions.handleProjectTitleKeyDown}
          onProjectContextMenu={(projectId, position) => {
            void threadActions.handleProjectContextMenu(projectId, position);
          }}
          onProjectTitlePointerDownCapture={threadActions.handleProjectTitlePointerDownCapture}
          onCreateThread={createThread}
          onExpandThreadList={threadActions.expandThreadListForProject}
          onCollapseThreadList={threadActions.collapseThreadListForProject}
          onToggleTreeNodeExpansion={threadActions.toggleSidebarTreeExpansion}
          onProjectDragStart={threadActions.handleProjectDragStart}
          onProjectDragEnd={threadActions.handleProjectDragEnd}
          onProjectDragCancel={threadActions.handleProjectDragCancel}
        />
      </SidebarContent>
      <SidebarSeparator />
      <SidebarFooterNav
        onOpenWorkflows={() => void navigate({ to: "/workflow/editor" })}
        onOpenSettings={() => void navigate({ to: "/settings" })}
      />
    </>
  );
}
