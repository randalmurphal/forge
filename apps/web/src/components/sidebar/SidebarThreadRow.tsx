import { ArchiveIcon, ChevronRightIcon, GitPullRequestIcon, TerminalIcon } from "lucide-react";
import type { Dispatch, MouseEvent, MutableRefObject, SetStateAction } from "react";
import type { GitStatusResult, ThreadId } from "@forgetools/contracts";
import { useSidebarThreadSummaryById } from "../../storeSelectors";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { useUiStateStore } from "../../uiStateStore";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { resolveThreadRowClassName, resolveThreadStatusPill } from "../Sidebar.logic";
import type { SidebarTreeVisibleNode } from "../SidebarTree.logic";
import { ThreadStatusLabel } from "./SidebarThreadStatus";
import { ClaudeAI, OpenAI } from "../Icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";

interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
}

type ThreadPr = GitStatusResult["pr"];

export interface SidebarThreadRowBindings {
  orderedProjectThreadIds: readonly ThreadId[];
  routeThreadId: ThreadId | null;
  selectedThreadIds: ReadonlySet<ThreadId>;
  showThreadJumpHints: boolean;
  jumpLabelByThreadId: ReadonlyMap<ThreadId, string>;
  appSettingsConfirmThreadArchive: boolean;
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  renamingInputRef: MutableRefObject<HTMLInputElement | null>;
  renamingCommittedRef: MutableRefObject<boolean>;
  confirmingArchiveThreadId: ThreadId | null;
  setConfirmingArchiveThreadId: Dispatch<SetStateAction<ThreadId | null>>;
  confirmArchiveButtonRefs: MutableRefObject<Map<ThreadId, HTMLButtonElement>>;
  handleThreadClick: (
    event: MouseEvent,
    threadId: ThreadId,
    orderedProjectThreadIds: readonly ThreadId[],
  ) => void;
  navigateToThread: (threadId: ThreadId) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadId: ThreadId,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (threadId: ThreadId, newTitle: string, originalTitle: string) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadId: ThreadId) => Promise<void>;
  openPrLink: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  toggleTreeNodeExpansion: (threadId: ThreadId) => void;
  prByThreadId: ReadonlyMap<ThreadId, ThreadPr | null>;
}

function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

function formatThreadRoleLabel(role: string | null): string | null {
  if (!role) {
    return null;
  }

  return role
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function ProviderIcon({ provider }: { provider: "codex" | "claudeAgent" }) {
  const Icon = provider === "claudeAgent" ? ClaudeAI : OpenAI;
  return <Icon className="size-3" />;
}

export function SidebarThreadRow(props: {
  threadId: ThreadId;
  treeNode: SidebarTreeVisibleNode | null;
  bindings: SidebarThreadRowBindings;
}) {
  const thread = useSidebarThreadSummaryById(props.threadId);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[props.threadId]);
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadId, props.threadId).runningTerminalIds,
  );

  if (!thread) {
    return null;
  }

  const isActive = props.bindings.routeThreadId === thread.id;
  const isSelected = props.bindings.selectedThreadIds.has(thread.id);
  const isHighlighted = isActive || isSelected;
  const isThreadRunning =
    thread.session?.status === "running" && thread.session.activeTurnId != null;
  const directThreadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });
  const threadStatus =
    props.treeNode && (props.treeNode.depth > 0 || props.treeNode.isExpandable)
      ? props.treeNode.displayStatus
      : directThreadStatus;
  const prStatus = prStatusIndicator(props.bindings.prByThreadId.get(thread.id) ?? null);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const isConfirmingArchive =
    props.bindings.confirmingArchiveThreadId === thread.id && !isThreadRunning;
  const threadMetaClassName = isConfirmingArchive
    ? "pointer-events-none opacity-0"
    : !isThreadRunning
      ? "pointer-events-none transition-opacity duration-150 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0"
      : "pointer-events-none";
  const roleLabel = formatThreadRoleLabel(thread.role ?? null);
  const isChildThread = (props.treeNode?.depth ?? 0) > 0;
  const rowPaddingLeft = 8 + (props.treeNode?.depth ?? 0) * 14;
  const isExpandable = props.treeNode?.isExpandable ?? false;
  const showChildMeta = isChildThread;
  const rowRelativeTime = formatRelativeTimeLabel(
    props.treeNode?.latestActivityAt ?? thread.updatedAt ?? thread.createdAt,
  );

  return (
    <SidebarMenuSubItem
      className="w-full"
      data-thread-item
      onMouseLeave={() => {
        props.bindings.setConfirmingArchiveThreadId((current) =>
          current === thread.id ? null : current,
        );
      }}
      onBlurCapture={(event) => {
        const currentTarget = event.currentTarget;
        requestAnimationFrame(() => {
          if (currentTarget.contains(document.activeElement)) {
            return;
          }
          props.bindings.setConfirmingArchiveThreadId((current) =>
            current === thread.id ? null : current,
          );
        });
      }}
    >
      <SidebarMenuSubButton
        render={<div role="button" tabIndex={0} />}
        size="sm"
        isActive={isActive}
        data-testid={`thread-row-${thread.id}`}
        className={`${resolveThreadRowClassName({
          isActive,
          isSelected,
          multiLine: showChildMeta,
        })} relative isolate`}
        style={{ paddingLeft: `${rowPaddingLeft}px` }}
        onClick={(event) => {
          props.bindings.handleThreadClick(
            event,
            thread.id,
            props.bindings.orderedProjectThreadIds,
          );
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          props.bindings.navigateToThread(thread.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (
            props.bindings.selectedThreadIds.size > 0 &&
            props.bindings.selectedThreadIds.has(thread.id)
          ) {
            void props.bindings.handleMultiSelectContextMenu({
              x: event.clientX,
              y: event.clientY,
            });
          } else {
            if (props.bindings.selectedThreadIds.size > 0) {
              props.bindings.clearSelection();
            }
            void props.bindings.handleThreadContextMenu(thread.id, {
              x: event.clientX,
              y: event.clientY,
            });
          }
        }}
      >
        <div className="flex min-w-0 flex-1 items-start gap-1.5 text-left">
          {props.treeNode && (props.treeNode.isExpandable || props.treeNode.depth > 0) ? (
            isExpandable ? (
              <button
                type="button"
                data-thread-selection-safe
                aria-label={`${props.treeNode.isExpanded ? "Collapse" : "Expand"} ${thread.title}`}
                className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.bindings.toggleTreeNodeExpansion(thread.id);
                }}
              >
                <ChevronRightIcon
                  className={`size-3 transition-transform ${props.treeNode.isExpanded ? "rotate-90" : ""}`}
                />
              </button>
            ) : (
              <span className="mt-0.5 inline-flex size-4 shrink-0" aria-hidden="true" />
            )
          ) : null}
          {prStatus ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={prStatus.tooltip}
                    className={`inline-flex cursor-pointer items-center justify-center rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${prStatus.colorClass}`}
                    onClick={(event) => {
                      props.bindings.openPrLink(event, prStatus.url);
                    }}
                  >
                    <GitPullRequestIcon className="size-3" />
                  </button>
                }
              />
              <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
            </Tooltip>
          ) : null}
          {!showChildMeta && threadStatus ? <ThreadStatusLabel status={threadStatus} /> : null}
          <div className="min-w-0 flex-1">
            {props.bindings.renamingThreadId === thread.id ? (
              <input
                ref={(element) => {
                  if (element && props.bindings.renamingInputRef.current !== element) {
                    props.bindings.renamingInputRef.current = element;
                    element.focus();
                    element.select();
                  }
                }}
                className="min-w-0 w-full truncate rounded border border-ring bg-transparent px-0.5 text-xs outline-none"
                value={props.bindings.renamingTitle}
                onChange={(event) => props.bindings.setRenamingTitle(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    props.bindings.renamingCommittedRef.current = true;
                    void props.bindings.commitRename(
                      thread.id,
                      props.bindings.renamingTitle,
                      thread.title,
                    );
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    props.bindings.renamingCommittedRef.current = true;
                    props.bindings.cancelRename();
                  }
                }}
                onBlur={() => {
                  if (!props.bindings.renamingCommittedRef.current) {
                    void props.bindings.commitRename(
                      thread.id,
                      props.bindings.renamingTitle,
                      thread.title,
                    );
                  }
                }}
                onClick={(event) => event.stopPropagation()}
              />
            ) : (
              <span className="block min-w-0 truncate text-xs">{thread.title}</span>
            )}
            {showChildMeta ? (
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground/75">
                {thread.session?.provider ? (
                  <span className="inline-flex shrink-0 items-center gap-1">
                    <ProviderIcon provider={thread.session.provider} />
                    <span>{thread.session.provider === "claudeAgent" ? "Claude" : "Codex"}</span>
                  </span>
                ) : null}
                {roleLabel ? (
                  <span className="inline-flex shrink-0 items-center rounded-full border border-border/70 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em] text-foreground/75">
                    {roleLabel}
                  </span>
                ) : null}
                {threadStatus ? (
                  <span className="min-w-0">
                    <ThreadStatusLabel status={threadStatus} compact />
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {terminalStatus ? (
            <span
              role="img"
              aria-label={terminalStatus.label}
              title={terminalStatus.label}
              className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
            >
              <TerminalIcon className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`} />
            </span>
          ) : null}
          <div className="flex min-w-12 justify-end">
            {isConfirmingArchive ? (
              <button
                ref={(element) => {
                  if (element) {
                    props.bindings.confirmArchiveButtonRefs.current.set(thread.id, element);
                  } else {
                    props.bindings.confirmArchiveButtonRefs.current.delete(thread.id);
                  }
                }}
                type="button"
                data-thread-selection-safe
                data-testid={`thread-archive-confirm-${thread.id}`}
                aria-label={`Confirm archive ${thread.title}`}
                className="absolute top-1/2 right-1 inline-flex h-5 -translate-y-1/2 cursor-pointer items-center rounded-full bg-destructive/12 px-2 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/18 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-destructive/40"
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.bindings.setConfirmingArchiveThreadId((current) =>
                    current === thread.id ? null : current,
                  );
                  void props.bindings.attemptArchiveThread(thread.id);
                }}
              >
                Confirm
              </button>
            ) : !isThreadRunning ? (
              props.bindings.appSettingsConfirmThreadArchive ? (
                <div className="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                  <button
                    type="button"
                    data-thread-selection-safe
                    data-testid={`thread-archive-${thread.id}`}
                    aria-label={`Archive ${thread.title}`}
                    className="inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      props.bindings.setConfirmingArchiveThreadId(thread.id);
                      requestAnimationFrame(() => {
                        props.bindings.confirmArchiveButtonRefs.current.get(thread.id)?.focus();
                      });
                    }}
                  >
                    <ArchiveIcon className="size-3.5" />
                  </button>
                </div>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <div className="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                        <button
                          type="button"
                          data-thread-selection-safe
                          data-testid={`thread-archive-${thread.id}`}
                          aria-label={`Archive ${thread.title}`}
                          className="inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                          onPointerDown={(event) => {
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void props.bindings.attemptArchiveThread(thread.id);
                          }}
                        >
                          <ArchiveIcon className="size-3.5" />
                        </button>
                      </div>
                    }
                  />
                  <TooltipPopup side="top">Archive</TooltipPopup>
                </Tooltip>
              )
            ) : null}
            <span className={threadMetaClassName}>
              {props.bindings.showThreadJumpHints ? (
                (() => {
                  const jumpLabel = props.bindings.jumpLabelByThreadId.get(thread.id);
                  return jumpLabel ? (
                    <span
                      className="inline-flex h-5 items-center rounded-full border border-border/80 bg-background/90 px-1.5 font-mono text-[10px] font-medium tracking-tight text-foreground shadow-sm"
                      title={jumpLabel}
                    >
                      {jumpLabel}
                    </span>
                  ) : (
                    <span
                      className={`text-[10px] ${
                        isHighlighted
                          ? "text-foreground/72 dark:text-foreground/82"
                          : "text-muted-foreground/40"
                      }`}
                    >
                      {rowRelativeTime}
                    </span>
                  );
                })()
              ) : (
                <span
                  className={`text-[10px] ${
                    isHighlighted
                      ? "text-foreground/72 dark:text-foreground/82"
                      : "text-muted-foreground/40"
                  }`}
                >
                  {rowRelativeTime}
                </span>
              )}
            </span>
          </div>
        </div>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
