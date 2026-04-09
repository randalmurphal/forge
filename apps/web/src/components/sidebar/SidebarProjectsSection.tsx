import {
  DndContext,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { PlusIcon } from "lucide-react";
import type {
  SidebarProjectSortOrder,
  SidebarThreadSortOrder,
} from "@forgetools/contracts/settings";
import type { ProjectId, ThreadId } from "@forgetools/contracts";
import {
  useCallback,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
} from "react";
import type { RenderedSidebarProject } from "./useSidebarData";
import { SidebarProjectItem, SortableProjectItem } from "./SidebarProjectItem";
import type { SidebarThreadRowBindings } from "./SidebarThreadRow";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SidebarGroup, SidebarMenu, SidebarMenuItem } from "../ui/sidebar";
import { autoAnimate } from "@formkit/auto-animate";
import { ArrowUpDownIcon, FolderIcon } from "lucide-react";

const SIDEBAR_SORT_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};

const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
};

const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;

function ProjectSortMenu(props: {
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground" />
          }
        >
          <ArrowUpDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">Sort projects</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-44">
        <MenuGroup>
          <div className="px-2 py-1 font-medium text-muted-foreground sm:text-xs">
            Sort projects
          </div>
          <MenuRadioGroup
            value={props.projectSortOrder}
            onValueChange={(value) => {
              props.onProjectSortOrderChange(value as SidebarProjectSortOrder);
            }}
          >
            {(Object.entries(SIDEBAR_SORT_LABELS) as Array<[SidebarProjectSortOrder, string]>).map(
              ([value, label]) => (
                <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                  {label}
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 font-medium text-muted-foreground sm:text-xs">
            Sort threads
          </div>
          <MenuRadioGroup
            value={props.threadSortOrder}
            onValueChange={(value) => {
              props.onThreadSortOrderChange(value as SidebarThreadSortOrder);
            }}
          >
            {(
              Object.entries(SIDEBAR_THREAD_SORT_LABELS) as Array<[SidebarThreadSortOrder, string]>
            ).map(([value, label]) => (
              <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function useProjectListAutoAnimateRef() {
  const animatedProjectListsRef = useRef(new WeakSet<HTMLElement>());

  return useCallback((node: HTMLElement | null) => {
    if (!node || animatedProjectListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedProjectListsRef.current.add(node);
  }, []);
}

export function SidebarProjectsSection(props: {
  isElectron: boolean;
  projectsCount: number;
  renderedProjects: readonly RenderedSidebarProject[];
  isManualProjectSorting: boolean;
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  shouldShowProjectPathEntry: boolean;
  isPickingFolder: boolean;
  isAddingProject: boolean;
  addProjectError: string | null;
  newCwd: string;
  canAddProject: boolean;
  addProjectInputRef: MutableRefObject<HTMLInputElement | null>;
  routeThreadId: ThreadId | null;
  selectedThreadIds: ReadonlySet<ThreadId>;
  showThreadJumpHints: boolean;
  jumpLabelByThreadId: ReadonlyMap<ThreadId, string>;
  appSettingsConfirmThreadArchive: boolean;
  defaultThreadEnvMode: "local" | "worktree";
  activeThreadSeed: {
    projectId: ProjectId;
    branch: string | null;
    worktreePath: string | null;
  } | null;
  activeDraftThreadSeed: {
    projectId: ProjectId;
    branch: string | null;
    worktreePath: string | null;
    envMode: "local" | "worktree";
  } | null;
  newThreadShortcutLabel: string | null;
  threadRowBindings: Omit<
    SidebarThreadRowBindings,
    | "orderedProjectThreadIds"
    | "routeThreadId"
    | "selectedThreadIds"
    | "showThreadJumpHints"
    | "jumpLabelByThreadId"
    | "appSettingsConfirmThreadArchive"
    | "prByThreadId"
  >;
  prByThreadId: ReadonlyMap<ThreadId, import("@forgetools/contracts").GitStatusResult["pr"] | null>;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  onStartAddProject: () => void;
  onPickFolder: () => void;
  onNewCwdChange: (cwd: string) => void;
  onSubmitAddProject: () => void;
  onCancelAddProject: () => void;
  onProjectClick: (event: MouseEvent<HTMLButtonElement>, projectId: ProjectId) => void;
  onProjectKeyDown: (event: KeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => void;
  onProjectContextMenu: (projectId: ProjectId, position: { x: number; y: number }) => void;
  onProjectTitlePointerDownCapture: (event: PointerEvent<HTMLButtonElement>) => void;
  onCreateThread: (
    projectId: ProjectId,
    input: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode: "local" | "worktree";
    },
  ) => void;
  onExpandThreadList: (projectId: ProjectId) => void;
  onCollapseThreadList: (projectId: ProjectId) => void;
  onToggleTreeNodeExpansion: (threadId: ThreadId) => void;
  onProjectDragStart: (event: DragStartEvent) => void;
  onProjectDragEnd: (event: DragEndEvent) => void;
  onProjectDragCancel: (event: DragCancelEvent) => void;
}) {
  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);
  const attachProjectListAutoAnimateRef = useProjectListAutoAnimateRef();

  return (
    <SidebarGroup className="px-2 py-2">
      <div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
          Projects
        </span>
        <div className="flex items-center gap-1">
          <ProjectSortMenu
            projectSortOrder={props.projectSortOrder}
            threadSortOrder={props.threadSortOrder}
            onProjectSortOrderChange={props.onProjectSortOrderChange}
            onThreadSortOrderChange={props.onThreadSortOrderChange}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={
                    props.shouldShowProjectPathEntry ? "Cancel add project" : "Add project"
                  }
                  aria-pressed={props.shouldShowProjectPathEntry}
                  className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                  onClick={props.onStartAddProject}
                />
              }
            >
              <PlusIcon
                className={`size-3.5 transition-transform duration-150 ${
                  props.shouldShowProjectPathEntry ? "rotate-45" : "rotate-0"
                }`}
              />
            </TooltipTrigger>
            <TooltipPopup side="right">
              {props.shouldShowProjectPathEntry ? "Cancel add project" : "Add project"}
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>

      {props.shouldShowProjectPathEntry ? (
        <div className="mb-2 px-1">
          {props.isElectron ? (
            <button
              type="button"
              className="mb-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-border bg-secondary py-1.5 text-xs text-foreground/80 transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              onClick={props.onPickFolder}
              disabled={props.isPickingFolder || props.isAddingProject}
            >
              <FolderIcon className="size-3.5" />
              {props.isPickingFolder ? "Picking folder..." : "Browse for folder"}
            </button>
          ) : null}
          <div className="flex gap-1.5">
            <input
              ref={props.addProjectInputRef}
              className={`min-w-0 flex-1 rounded-md border bg-secondary px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none ${
                props.addProjectError
                  ? "border-destructive/70 focus:border-destructive"
                  : "border-border focus:border-ring"
              }`}
              placeholder="/path/to/project"
              value={props.newCwd}
              onChange={(event) => props.onNewCwdChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") props.onSubmitAddProject();
                if (event.key === "Escape") props.onCancelAddProject();
              }}
              autoFocus
            />
            <button
              type="button"
              className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
              onClick={props.onSubmitAddProject}
              disabled={!props.canAddProject}
            >
              {props.isAddingProject ? "Adding..." : "Add"}
            </button>
          </div>
          {props.addProjectError ? (
            <p className="mt-1 px-0.5 text-[11px] leading-tight text-destructive">
              {props.addProjectError}
            </p>
          ) : null}
        </div>
      ) : null}

      {props.isManualProjectSorting ? (
        <DndContext
          sensors={projectDnDSensors}
          collisionDetection={projectCollisionDetection}
          modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
          onDragStart={props.onProjectDragStart}
          onDragEnd={props.onProjectDragEnd}
          onDragCancel={props.onProjectDragCancel}
        >
          <SidebarMenu>
            <SortableContext
              items={props.renderedProjects.map((renderedProject) => renderedProject.project.id)}
              strategy={verticalListSortingStrategy}
            >
              {props.renderedProjects.map((renderedProject) => (
                <SortableProjectItem
                  key={renderedProject.project.id}
                  projectId={renderedProject.project.id}
                >
                  {(dragHandleProps) => (
                    <SidebarProjectItem
                      renderedProject={renderedProject}
                      isManualProjectSorting
                      dragHandleProps={dragHandleProps}
                      routeThreadId={props.routeThreadId}
                      selectedThreadIds={props.selectedThreadIds}
                      showThreadJumpHints={props.showThreadJumpHints}
                      jumpLabelByThreadId={props.jumpLabelByThreadId}
                      appSettingsConfirmThreadArchive={props.appSettingsConfirmThreadArchive}
                      defaultThreadEnvMode={props.defaultThreadEnvMode}
                      activeThreadSeed={props.activeThreadSeed}
                      activeDraftThreadSeed={props.activeDraftThreadSeed}
                      newThreadShortcutLabel={props.newThreadShortcutLabel}
                      threadRowBindings={props.threadRowBindings}
                      onProjectClick={props.onProjectClick}
                      onProjectKeyDown={props.onProjectKeyDown}
                      onProjectContextMenu={props.onProjectContextMenu}
                      onProjectTitlePointerDownCapture={props.onProjectTitlePointerDownCapture}
                      onCreateThread={props.onCreateThread}
                      onExpandThreadList={props.onExpandThreadList}
                      onCollapseThreadList={props.onCollapseThreadList}
                      onToggleTreeNodeExpansion={props.onToggleTreeNodeExpansion}
                      prByThreadId={props.prByThreadId}
                    />
                  )}
                </SortableProjectItem>
              ))}
            </SortableContext>
          </SidebarMenu>
        </DndContext>
      ) : (
        <SidebarMenu ref={attachProjectListAutoAnimateRef}>
          {props.renderedProjects.map((renderedProject) => (
            <SidebarMenuItem key={renderedProject.project.id} className="rounded-md">
              <SidebarProjectItem
                renderedProject={renderedProject}
                isManualProjectSorting={false}
                dragHandleProps={null}
                routeThreadId={props.routeThreadId}
                selectedThreadIds={props.selectedThreadIds}
                showThreadJumpHints={props.showThreadJumpHints}
                jumpLabelByThreadId={props.jumpLabelByThreadId}
                appSettingsConfirmThreadArchive={props.appSettingsConfirmThreadArchive}
                defaultThreadEnvMode={props.defaultThreadEnvMode}
                activeThreadSeed={props.activeThreadSeed}
                activeDraftThreadSeed={props.activeDraftThreadSeed}
                newThreadShortcutLabel={props.newThreadShortcutLabel}
                threadRowBindings={props.threadRowBindings}
                onProjectClick={props.onProjectClick}
                onProjectKeyDown={props.onProjectKeyDown}
                onProjectContextMenu={props.onProjectContextMenu}
                onProjectTitlePointerDownCapture={props.onProjectTitlePointerDownCapture}
                onCreateThread={props.onCreateThread}
                onExpandThreadList={props.onExpandThreadList}
                onCollapseThreadList={props.onCollapseThreadList}
                onToggleTreeNodeExpansion={props.onToggleTreeNodeExpansion}
                prByThreadId={props.prByThreadId}
              />
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      )}

      {props.projectsCount === 0 && !props.shouldShowProjectPathEntry ? (
        <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
          No projects yet
        </div>
      ) : null}
    </SidebarGroup>
  );
}
