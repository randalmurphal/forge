import { autoAnimate } from "@formkit/auto-animate";
import { ChevronRightIcon, SquarePenIcon } from "lucide-react";
import { CSS } from "@dnd-kit/utilities";
import { useSortable } from "@dnd-kit/sortable";
import type { ProjectId, ThreadId } from "@forgetools/contracts";
import {
  useCallback,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { RenderedSidebarProject } from "./useSidebarData";
import type { SidebarThreadRowBindings } from "./SidebarThreadRow";
import { SidebarThreadRow } from "./SidebarThreadRow";
import { ThreadStatusLabel } from "./SidebarThreadStatus";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  resolveSidebarNewThreadEnvMode,
  resolveSidebarNewThreadSeedContext,
} from "../Sidebar.logic";
import { SidebarTree } from "../SidebarTree";
import type { SidebarTreeVisibleNode } from "../SidebarTree.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../ui/sidebar";

const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;

export type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

export function SortableProjectItem(props: {
  projectId: ProjectId;
  disabled?: boolean;
  children: (handleProps: SortableProjectHandleProps) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable(
    props.disabled === undefined
      ? { id: props.projectId }
      : { id: props.projectId, disabled: props.disabled },
  );

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {props.children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

function useAutoAnimateListRef() {
  const animatedListsRef = useRef(new WeakSet<HTMLElement>());

  return useCallback((node: HTMLElement | null) => {
    if (!node || animatedListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedListsRef.current.add(node);
  }, []);
}

export function SidebarProjectItem(props: {
  renderedProject: RenderedSidebarProject;
  isManualProjectSorting: boolean;
  dragHandleProps: SortableProjectHandleProps | null;
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
  prByThreadId: ReadonlyMap<ThreadId, import("@forgetools/contracts").GitStatusResult["pr"] | null>;
}) {
  const threadListAutoAnimateRef = useAutoAnimateListRef();
  const {
    hasHiddenThreads,
    hiddenThreadStatus,
    orderedProjectThreadIds,
    project,
    projectStatus,
    renderedTreeNodes,
    showEmptyThreadState,
    shouldShowThreadPanel,
    isThreadListExpanded,
  } = props.renderedProject;

  const threadRowBindings: SidebarThreadRowBindings = {
    ...props.threadRowBindings,
    orderedProjectThreadIds,
    routeThreadId: props.routeThreadId,
    selectedThreadIds: props.selectedThreadIds,
    showThreadJumpHints: props.showThreadJumpHints,
    jumpLabelByThreadId: props.jumpLabelByThreadId,
    appSettingsConfirmThreadArchive: props.appSettingsConfirmThreadArchive,
    prByThreadId: props.prByThreadId,
  };

  return (
    <>
      <div className="group/project-header relative">
        <SidebarMenuButton
          ref={
            props.isManualProjectSorting ? props.dragHandleProps?.setActivatorNodeRef : undefined
          }
          size="sm"
          className={`gap-2 px-2 py-1.5 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground ${
            props.isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
          }`}
          {...(props.isManualProjectSorting && props.dragHandleProps
            ? props.dragHandleProps.attributes
            : {})}
          {...(props.isManualProjectSorting && props.dragHandleProps
            ? props.dragHandleProps.listeners
            : {})}
          onPointerDownCapture={props.onProjectTitlePointerDownCapture}
          onClick={(event) => props.onProjectClick(event, project.id)}
          onKeyDown={(event) => props.onProjectKeyDown(event, project.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            props.onProjectContextMenu(project.id, {
              x: event.clientX,
              y: event.clientY,
            });
          }}
        >
          {!project.expanded && projectStatus ? (
            <span
              aria-hidden="true"
              title={projectStatus.label}
              className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
            >
              <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                <span
                  className={`size-[9px] rounded-full ${projectStatus.dotClass} ${
                    projectStatus.pulse ? "animate-pulse" : ""
                  }`}
                />
              </span>
              <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100" />
            </span>
          ) : (
            <ChevronRightIcon
              className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                project.expanded ? "rotate-90" : ""
              }`}
            />
          )}
          <ProjectFavicon cwd={project.cwd} />
          <span className="flex-1 truncate text-xs font-medium text-foreground/90">
            {project.name}
          </span>
        </SidebarMenuButton>
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuAction
                render={
                  <button
                    type="button"
                    aria-label={`Create new thread in ${project.name}`}
                    data-testid="new-thread-button"
                  />
                }
                showOnHover
                className="top-1 right-1.5 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const seedContext = resolveSidebarNewThreadSeedContext({
                    projectId: project.id,
                    defaultEnvMode: resolveSidebarNewThreadEnvMode({
                      defaultEnvMode: props.defaultThreadEnvMode,
                    }),
                    activeThread:
                      props.activeThreadSeed && props.activeThreadSeed.projectId === project.id
                        ? props.activeThreadSeed
                        : null,
                    activeDraftThread:
                      props.activeDraftThreadSeed &&
                      props.activeDraftThreadSeed.projectId === project.id
                        ? props.activeDraftThreadSeed
                        : null,
                  });
                  props.onCreateThread(project.id, seedContext);
                }}
              >
                <SquarePenIcon className="size-3.5" />
              </SidebarMenuAction>
            }
          />
          <TooltipPopup side="top">
            {props.newThreadShortcutLabel
              ? `New thread (${props.newThreadShortcutLabel})`
              : "New thread"}
          </TooltipPopup>
        </Tooltip>
      </div>

      <SidebarMenuSub
        ref={threadListAutoAnimateRef}
        className="mx-1 my-0 w-full translate-x-0 gap-0.5 overflow-hidden px-1.5 py-0"
      >
        {shouldShowThreadPanel && showEmptyThreadState ? (
          <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
            <div
              data-thread-selection-safe
              className="flex h-6 w-full translate-x-0 items-center px-2 text-left text-[10px] text-muted-foreground/60"
            >
              <span>No threads yet</span>
            </div>
          </SidebarMenuSubItem>
        ) : null}
        {shouldShowThreadPanel ? (
          <SidebarTree
            nodes={renderedTreeNodes}
            renderNode={(treeNode: SidebarTreeVisibleNode) => (
              <SidebarThreadRow
                key={treeNode.thread.id}
                threadId={treeNode.thread.id}
                treeNode={treeNode}
                bindings={threadRowBindings}
              />
            )}
          />
        ) : null}

        {project.expanded && hasHiddenThreads && !isThreadListExpanded ? (
          <SidebarMenuSubItem className="w-full">
            <SidebarMenuSubButton
              render={<button type="button" />}
              data-thread-selection-safe
              size="sm"
              className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
              onClick={() => {
                props.onExpandThreadList(project.id);
              }}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {hiddenThreadStatus ? (
                  <ThreadStatusLabel status={hiddenThreadStatus} compact />
                ) : null}
                <span>Show more</span>
              </span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        ) : null}
        {project.expanded && hasHiddenThreads && isThreadListExpanded ? (
          <SidebarMenuSubItem className="w-full">
            <SidebarMenuSubButton
              render={<button type="button" />}
              data-thread-selection-safe
              size="sm"
              className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
              onClick={() => {
                props.onCollapseThreadList(project.id);
              }}
            >
              <span>Show less</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        ) : null}
      </SidebarMenuSub>
    </>
  );
}
