import { type MessageId, type ThreadId, type TurnId } from "@forgetools/contracts";
import { useQuery } from "@tanstack/react-query";
import { resolveRoleColor } from "../../lib/roleColors";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  measureElement as measureVirtualElement,
  type VirtualItem,
  useVirtualizer,
} from "@tanstack/react-virtual";
import {
  deriveTimelineEntries,
  formatDuration,
  formatElapsed,
  type ExpandedInlineDiffState,
  type ToolInlineDiffSummary,
  type WorkLogEntry,
} from "../../session-logic";
import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX } from "../../chat-scroll";
import { type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import { agentDiffQueryOptions } from "../../lib/providerReactQuery";
import {
  classifyDiffComplexity,
  getDiffLoadingLabel,
  getCompactDiffPreviewContent,
  summarizeDiffFileSummaries,
} from "../../lib/diffRendering";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  BoxIcon,
  CheckIcon,
  Columns2Icon,
  ChevronRightIcon,
  CircleAlertIcon,
  EyeIcon,
  FolderSearchIcon,
  GlobeIcon,
  type LucideIcon,
  NetworkIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { clamp } from "effect/Number";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { SummaryCard } from "./SummaryCard";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  deriveMessagesTimelineRows,
  estimateMessagesTimelineRowHeight,
  normalizeCompactToolLabel,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { SubagentSection } from "./SubagentSection";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@forgetools/contracts/settings";
import { useSettings } from "../../hooks/useSettings";
import { formatTimestamp } from "../../timestampFormat";
import { CompactDiffCard } from "../diff/CompactDiffCard";
import { CompactDiffEntryRow } from "../diff/CompactDiffEntryRow";
import { CompactDiffHeader } from "../diff/CompactDiffHeader";
import { CompactDiffPreview } from "../diff/CompactDiffPreview";
import { CompactDiffSummaryFallback } from "../diff/CompactDiffSummaryFallback";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;

interface MessagesTimelineProps {
  threadId: ThreadId | null;
  hasMessages: boolean;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  workingParticipantLabels?: ReadonlyArray<{ label: string; role: string }>;
  scrollContainer: HTMLDivElement | null;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  nowIso: string;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  onVirtualizerSnapshot?: (snapshot: {
    totalSize: number;
    measurements: ReadonlyArray<{
      id: string;
      kind: MessagesTimelineRow["kind"];
      index: number;
      size: number;
      start: number;
      end: number;
    }>;
  }) => void;
}

export const MessagesTimeline = memo(function MessagesTimeline({
  threadId,
  hasMessages,
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  workingParticipantLabels,
  scrollContainer,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  nowIso,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  onVirtualizerSnapshot,
}: MessagesTimelineProps) {
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const [timelineWidthPx, setTimelineWidthPx] = useState<number | null>(null);
  const [expandedInlineDiff, setExpandedInlineDiff] = useState<ExpandedInlineDiffState>(null);
  const [expandedSubagentTaskId, setExpandedSubagentTaskId] = useState<string | null>(null);
  const onToggleSubagent = useCallback((taskId: string) => {
    setExpandedSubagentTaskId((prev) => (prev === taskId ? null : taskId));
  }, []);
  const settings = useSettings();

  useLayoutEffect(() => {
    const timelineRoot = timelineRootRef.current;
    if (!timelineRoot) return;

    const updateWidth = (nextWidth: number) => {
      setTimelineWidthPx((previousWidth) => {
        if (previousWidth !== null && Math.abs(previousWidth - nextWidth) < 0.5) {
          return previousWidth;
        }
        return nextWidth;
      });
    };

    updateWidth(timelineRoot.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      updateWidth(timelineRoot.getBoundingClientRect().width);
    });
    observer.observe(timelineRoot);
    return () => {
      observer.disconnect();
    };
  }, [hasMessages, isWorking]);

  const rows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId,
        isWorking,
        activeTurnStartedAt,
        ...(workingParticipantLabels !== undefined ? { workingParticipantLabels } : {}),
      }),
    [
      timelineEntries,
      completionDividerBeforeEntryId,
      isWorking,
      activeTurnStartedAt,
      workingParticipantLabels,
    ],
  );

  const firstUnvirtualizedRowIndex = useMemo(() => {
    const firstTailRowIndex = Math.max(rows.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS, 0);
    if (!activeTurnInProgress) return firstTailRowIndex;

    const turnStartedAtMs =
      typeof activeTurnStartedAt === "string" ? Date.parse(activeTurnStartedAt) : Number.NaN;
    let firstCurrentTurnRowIndex = -1;
    if (!Number.isNaN(turnStartedAtMs)) {
      firstCurrentTurnRowIndex = rows.findIndex((row) => {
        if (row.kind === "working") return true;
        if (!row.createdAt) return false;
        const rowCreatedAtMs = Date.parse(row.createdAt);
        return !Number.isNaN(rowCreatedAtMs) && rowCreatedAtMs >= turnStartedAtMs;
      });
    }

    if (firstCurrentTurnRowIndex < 0) {
      firstCurrentTurnRowIndex = rows.findIndex(
        (row) => row.kind === "message" && row.message.streaming,
      );
    }

    if (firstCurrentTurnRowIndex < 0) return firstTailRowIndex;

    for (let index = firstCurrentTurnRowIndex - 1; index >= 0; index -= 1) {
      const previousRow = rows[index];
      if (!previousRow || previousRow.kind !== "message") continue;
      if (previousRow.message.role === "user") {
        return Math.min(index, firstTailRowIndex);
      }
      if (previousRow.message.role === "assistant" && !previousRow.message.streaming) {
        break;
      }
    }

    return Math.min(firstCurrentTurnRowIndex, firstTailRowIndex);
  }, [activeTurnInProgress, activeTurnStartedAt, rows]);

  const virtualizedRowCount = clamp(firstUnvirtualizedRowIndex, {
    minimum: 0,
    maximum: rows.length,
  });
  const virtualMeasurementScopeKey =
    timelineWidthPx === null ? "width:unknown" : `width:${Math.round(timelineWidthPx)}`;

  const rowVirtualizer = useVirtualizer({
    count: virtualizedRowCount,
    getScrollElement: () => scrollContainer,
    // Scope cached row measurements to the current timeline width so offscreen
    // rows do not keep stale heights after wrapping changes.
    getItemKey: (index: number) => {
      const rowId = rows[index]?.id ?? String(index);
      return `${virtualMeasurementScopeKey}:${rowId}`;
    },
    estimateSize: (index: number) => {
      const row = rows[index];
      if (!row) return 96;
      return estimateMessagesTimelineRowHeight(row, {
        expandedWorkGroups,
        expandedInlineDiff,
        expandedSubagentTaskId,
        timelineWidthPx,
        turnDiffSummaryByAssistantMessageId,
      });
    },
    measureElement: measureVirtualElement,
    useAnimationFrameWithResizeObserver: true,
    overscan: 8,
  });
  useEffect(() => {
    if (timelineWidthPx === null) return;
    rowVirtualizer.measure();
  }, [
    expandedInlineDiff,
    expandedSubagentTaskId,
    expandedWorkGroups,
    rowVirtualizer,
    timelineWidthPx,
    turnDiffSummaryByAssistantMessageId,
  ]);
  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
      const viewportHeight = instance.scrollRect?.height ?? 0;
      const scrollOffset = instance.scrollOffset ?? 0;
      const itemIntersectsViewport =
        item.end > scrollOffset && item.start < scrollOffset + viewportHeight;
      if (itemIntersectsViewport) {
        return false;
      }
      const remainingDistance = instance.getTotalSize() - (scrollOffset + viewportHeight);
      return remainingDistance > AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    };
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [rowVirtualizer]);
  const pendingMeasureFrameRef = useRef<number | null>(null);
  const onTimelineImageLoad = useCallback(() => {
    if (pendingMeasureFrameRef.current !== null) return;
    pendingMeasureFrameRef.current = window.requestAnimationFrame(() => {
      pendingMeasureFrameRef.current = null;
      rowVirtualizer.measure();
    });
  }, [rowVirtualizer]);
  useEffect(() => {
    return () => {
      const frame = pendingMeasureFrameRef.current;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);
  useLayoutEffect(() => {
    if (!onVirtualizerSnapshot) {
      return;
    }
    onVirtualizerSnapshot({
      totalSize: rowVirtualizer.getTotalSize(),
      measurements: rowVirtualizer.measurementsCache
        .slice(0, virtualizedRowCount)
        .flatMap((measurement) => {
          const row = rows[measurement.index];
          if (!row) {
            return [];
          }
          return [
            {
              id: row.id,
              kind: row.kind,
              index: measurement.index,
              size: measurement.size,
              start: measurement.start,
              end: measurement.end,
            },
          ];
        }),
    });
  }, [onVirtualizerSnapshot, rowVirtualizer, rows, virtualizedRowCount]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const nonVirtualizedRows = rows.slice(virtualizedRowCount);
  const onToggleInlineDiff = useCallback((scope: "tool" | "turn", id: string) => {
    setExpandedInlineDiff((current) =>
      current?.scope === scope && current.id === id ? null : { scope, id },
    );
  }, []);

  const renderSubagentWorkEntry = useCallback(
    (entry: WorkLogEntry) => (
      <SimpleWorkEntryRow
        workEntry={entry}
        expandedInlineDiff={expandedInlineDiff}
        onToggleInlineDiff={onToggleInlineDiff}
      />
    ),
    [expandedInlineDiff, onToggleInlineDiff],
  );

  const renderRowContent = (row: TimelineRow) => (
    <div
      className="pb-4"
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work-group" && (
        <GroupedWorkEntriesRow
          row={row}
          expandedWorkGroups={expandedWorkGroups}
          onToggleWorkGroup={onToggleWorkGroup}
          expandedInlineDiff={expandedInlineDiff}
          onToggleInlineDiff={onToggleInlineDiff}
        />
      )}

      {row.kind === "work-entry" && (
        <StandaloneWorkEntryRow
          workEntry={row.entry}
          expandedInlineDiff={expandedInlineDiff}
          onToggleInlineDiff={onToggleInlineDiff}
        />
      )}

      {row.kind === "subagent-section" && (
        <SubagentSection
          groups={row.subagentGroups}
          expandedTaskId={expandedSubagentTaskId}
          onToggle={onToggleSubagent}
          renderWorkEntry={renderSubagentWorkEntry}
          nowIso={nowIso}
        />
      )}

      {row.kind === "running-subagents" && (
        <SubagentSection
          groups={row.subagentGroups}
          expandedTaskId={expandedSubagentTaskId}
          onToggle={onToggleSubagent}
          renderWorkEntry={renderSubagentWorkEntry}
          nowIso={nowIso}
          sectionLabel={`Running (${row.subagentGroups.length})`}
        />
      )}

      {row.kind === "message" &&
        row.message.role === "user" &&
        (() => {
          const userImages = row.message.attachments ?? [];
          const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
          const terminalContexts = displayedUserMessage.contexts;
          const canRevertAgentWork = revertTurnCountByUserMessageId.has(row.message.id);
          return (
            <div className="flex justify-end">
              <div className="group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
                {userImages.length > 0 && (
                  <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
                    {userImages.map(
                      (image: NonNullable<TimelineMessage["attachments"]>[number]) => (
                        <div
                          key={image.id}
                          className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
                        >
                          {image.previewUrl ? (
                            <button
                              type="button"
                              className="h-full w-full cursor-zoom-in"
                              aria-label={`Preview ${image.name}`}
                              onClick={() => {
                                const preview = buildExpandedImagePreview(userImages, image.id);
                                if (!preview) return;
                                onImageExpand(preview);
                              }}
                            >
                              <img
                                src={image.previewUrl}
                                alt={image.name}
                                className="h-full max-h-[220px] w-full object-cover"
                                onLoad={onTimelineImageLoad}
                                onError={onTimelineImageLoad}
                              />
                            </button>
                          ) : (
                            <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                              {image.name}
                            </div>
                          )}
                        </div>
                      ),
                    )}
                  </div>
                )}
                {(displayedUserMessage.visibleText.trim().length > 0 ||
                  terminalContexts.length > 0) && (
                  <UserMessageBody
                    text={displayedUserMessage.visibleText}
                    terminalContexts={terminalContexts}
                  />
                )}
                <div className="mt-1.5 flex items-center justify-end gap-2">
                  <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                    {displayedUserMessage.copyText && (
                      <MessageCopyButton markdown={displayedUserMessage.copyText} />
                    )}
                    {canRevertAgentWork && (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={isRevertingCheckpoint || isWorking}
                        onClick={() => onRevertUserMessage(row.message.id)}
                        title="Revert to this message"
                      >
                        <Undo2Icon className="size-3" />
                      </Button>
                    )}
                  </div>
                  <p className="text-right text-[10px] text-muted-foreground/30">
                    {formatTimestamp(row.message.createdAt, timestampFormat)}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "assistant" &&
        row.message.attribution?.role === "summary" &&
        (() => {
          return (
            <div className="min-w-0 px-1 py-0.5">
              <SummaryCard
                text={row.message.text}
                model={row.message.attribution.model}
                cwd={markdownCwd}
                isStreaming={Boolean(row.message.streaming)}
              />
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "assistant" &&
        row.message.attribution?.role !== "summary" &&
        (() => {
          const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
          const attributionLabel = row.message.attribution
            ? `${formatAttributionRole(row.message.attribution.role)} · ${row.message.attribution.model}`
            : null;
          return (
            <>
              {row.showCompletionDivider && (
                <div className="my-3 flex items-center gap-3">
                  <span className="h-px flex-1 bg-border" />
                  <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
                    {completionSummary ? `Response • ${completionSummary}` : "Response"}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              <div className="group min-w-0 px-1 py-0.5">
                {row.message.attribution ? (
                  <p
                    className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.12em]"
                    style={{
                      color: resolveRoleColor(
                        row.message.attribution.role,
                        resolvedTheme,
                        settings,
                      ),
                    }}
                  >
                    {attributionLabel}
                  </p>
                ) : null}
                <ChatMarkdown
                  text={messageText}
                  cwd={markdownCwd}
                  isStreaming={Boolean(row.message.streaming)}
                />
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                    {!row.message.streaming && row.message.text.length > 0 ? (
                      <MessageCopyButton markdown={row.message.text} />
                    ) : null}
                  </div>
                  <p className="text-[10px] text-muted-foreground/30">
                    {formatMessageMeta(
                      row.message.createdAt,
                      row.message.streaming
                        ? formatElapsed(row.durationStart, nowIso)
                        : formatElapsed(row.durationStart, row.message.completedAt),
                      timestampFormat,
                    )}
                  </p>
                </div>
                {(() => {
                  const turnSummary = turnDiffSummaryByAssistantMessageId.get(row.message.id);
                  if (!turnSummary) return null;
                  const checkpointFiles = turnSummary.files;
                  if (checkpointFiles.length === 0) return null;
                  return (
                    <InlineTurnDiffBlock
                      threadId={threadId}
                      turnSummary={turnSummary}
                      expandedInlineDiff={expandedInlineDiff}
                      onToggleInlineDiff={onToggleInlineDiff}
                      onOpenTurnDiff={onOpenTurnDiff}
                    />
                  );
                })()}
              </div>
            </>
          );
        })()}

      {row.kind === "proposed-plan" && (
        <div className="min-w-0 px-1 py-0.5">
          <ProposedPlanCard
            planMarkdown={row.proposedPlan.planMarkdown}
            cwd={markdownCwd}
            workspaceRoot={workspaceRoot}
          />
        </div>
      )}

      {row.kind === "working" && (
        <div className="py-0.5 pl-1.5">
          <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70">
            <span className="inline-flex items-center gap-[3px]">
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:200ms]" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:400ms]" />
            </span>
            <span>
              {row.createdAt
                ? `Working for ${formatWorkingTimer(row.createdAt, nowIso) ?? "0s"}`
                : "Working..."}
            </span>
          </div>
          {row.participantLabels.length > 0 ? (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-4 text-[10px]">
              {row.participantLabels.map((participant) => {
                const color = resolveRoleColor(participant.role, resolvedTheme, settings);
                return (
                  <span
                    key={`working-participant:${participant.label}`}
                    className="rounded-full border px-2 py-0.5"
                    style={{ color, borderColor: `${color}40` }}
                  >
                    {participant.label}
                  </span>
                );
              })}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );

  if (!hasMessages && !isWorking) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={timelineRootRef}
      data-timeline-root="true"
      className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden"
    >
      {virtualizedRowCount > 0 && (
        <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {virtualRows.map((virtualRow: VirtualItem) => {
            const row = rows[virtualRow.index];
            if (!row) return null;

            return (
              <div
                key={`virtual-row:${row.id}`}
                data-index={virtualRow.index}
                data-virtual-row-id={row.id}
                data-virtual-row-kind={row.kind}
                data-virtual-row-size={virtualRow.size}
                data-virtual-row-start={virtualRow.start}
                ref={rowVirtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderRowContent(row)}
              </div>
            );
          })}
        </div>
      )}

      {nonVirtualizedRows.map((row) => (
        <div key={`non-virtual-row:${row.id}`}>{renderRowContent(row)}</div>
      ))}
    </div>
  );
});

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineWorkEntry = WorkLogEntry;
type TimelineRow = MessagesTimelineRow;

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatAttributionRole(role: string): string {
  return role
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} • ${duration}`;
}

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
}) {
  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              {props.text.slice(cursor, matchIndex)}
            </span>,
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              {props.text.slice(cursor)}
            </span>,
          );
        }

        return (
          <div className="wrap-break-word whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(<span key="user-message-terminal-context-inline-text">{props.text}</span>);
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="wrap-break-word whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <pre className="whitespace-pre-wrap wrap-break-word font-mono text-sm leading-relaxed text-foreground">
      {props.text}
    </pre>
  );
});

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground/92",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground/92",
  };
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
}

function extractSubagentPreview(detail: string | undefined): string | null {
  if (!detail) return null;
  // The detail often looks like 'Agent: {"description":"...","model":"opus","prompt":"..."}'
  // Try to extract the description field from the JSON
  const jsonStart = detail.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(detail.slice(jsonStart));
      if (typeof parsed === "object" && parsed !== null) {
        const description =
          typeof parsed.description === "string" ? parsed.description.trim() : null;
        if (description) return description;
        const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : null;
        if (prompt) return prompt.length > 120 ? `${prompt.slice(0, 117)}...` : prompt;
      }
    } catch {
      // Not valid JSON — fall through
    }
  }
  // Strip tool name prefix like "Agent: ..." or "Task: ..."
  const prefixMatch = /^[A-Za-z]+:\s*/.exec(detail);
  if (prefixMatch) {
    const rest = detail.slice(prefixMatch[0].length).trim();
    if (rest.length > 0) return rest.length > 120 ? `${rest.slice(0, 117)}...` : rest;
  }
  return detail.length > 120 ? `${detail.slice(0, 117)}...` : detail;
}

function workEntryPreview(workEntry: TimelineWorkEntry): string | null {
  // Commands: show the command string
  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return workEntry.command ?? workEntry.detail ?? null;
  }

  // File changes: show file path
  if (workEntry.itemType === "file_change") {
    if (workEntry.filePath) return workEntry.filePath;
    if ((workEntry.changedFiles?.length ?? 0) > 0) {
      const [firstPath] = workEntry.changedFiles!;
      return workEntry.changedFiles!.length === 1
        ? (firstPath ?? null)
        : `${firstPath} +${workEntry.changedFiles!.length - 1} more`;
    }
    return workEntry.detail ?? null;
  }

  // File reads: show file path
  if (workEntry.itemType === "file_read") {
    return workEntry.filePath ?? workEntry.detail ?? null;
  }

  // Search: show the pattern
  if (workEntry.itemType === "search") {
    if (workEntry.searchPattern) {
      const count = workEntry.searchResultCount;
      return count !== undefined
        ? `/${workEntry.searchPattern}/ → ${count} results`
        : `/${workEntry.searchPattern}/`;
    }
    return workEntry.detail ?? null;
  }

  // Subagent: use structured fields, falling back to JSON parsing
  if (workEntry.itemType === "collab_agent_tool_call") {
    if (workEntry.agentDescription) return workEntry.agentDescription;
    if (workEntry.agentPrompt) {
      return workEntry.agentPrompt.length > 120
        ? `${workEntry.agentPrompt.slice(0, 117)}...`
        : workEntry.agentPrompt;
    }
    return extractSubagentPreview(workEntry.detail) ?? null;
  }

  // MCP: show detail or arguments summary
  if (workEntry.itemType === "mcp_tool_call") {
    return workEntry.detail ?? null;
  }

  // Web search: show query
  if (workEntry.itemType === "web_search") {
    return workEntry.detail ?? null;
  }

  // Generic fallback
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) > 0) {
    const [firstPath] = workEntry.changedFiles ?? [];
    if (!firstPath) return null;
    return workEntry.changedFiles!.length === 1
      ? firstPath
      : `${firstPath} +${workEntry.changedFiles!.length - 1} more`;
  }
  return null;
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  // Approval-specific overrides
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  // Type-specific icons
  switch (workEntry.itemType) {
    case "command_execution":
      return TerminalIcon;
    case "file_change":
      return SquarePenIcon;
    case "file_read":
      return EyeIcon;
    case "search":
      return FolderSearchIcon;
    case "mcp_tool_call":
      return NetworkIcon;
    case "web_search":
      return GlobeIcon;
    case "image_view":
      return EyeIcon;
    case "collab_agent_tool_call":
      return BoxIcon;
    case "dynamic_tool_call":
      return WrenchIcon;
  }

  // Fallback heuristics
  if (workEntry.command) return TerminalIcon;
  if ((workEntry.changedFiles?.length ?? 0) > 0) return SquarePenIcon;

  return workToneIcon(workEntry.tone).icon;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

/** Map raw tool names to a clean display label for agent tool calls. */
function normalizeAgentToolName(toolName: string | undefined): string {
  if (!toolName) return "Agent";
  const lower = toolName.toLowerCase();
  // Codex sends "collabAgentToolCall" — normalize to "Agent"
  if (lower.includes("collab")) return "Agent";
  // Claude sends "Agent", "Task", "dispatch_agent", etc. — capitalize
  return capitalizePhrase(toolName);
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  // For agent/subagent tool calls, show a clean name with optional type/model metadata
  if (workEntry.itemType === "collab_agent_tool_call") {
    const name = normalizeAgentToolName(workEntry.toolName);
    const parts: string[] = [];
    if (workEntry.agentType) parts.push(workEntry.agentType);
    if (workEntry.agentModel) parts.push(workEntry.agentModel);
    return parts.length > 0 ? `${name} (${parts.join(", ")})` : name;
  }

  // For MCP tools, show server:tool format
  if (workEntry.itemType === "mcp_tool_call" && workEntry.mcpServer && workEntry.mcpTool) {
    return `${workEntry.mcpServer}:${workEntry.mcpTool}`;
  }

  // For commands, use "Command" (not the raw tool name)
  if (workEntry.itemType === "command_execution") {
    return "Command";
  }

  // Use the actual tool name if available and meaningful
  if (workEntry.toolName) {
    const name = workEntry.toolName;
    // Strip mcp__ prefix if present
    if (name.startsWith("mcp__")) {
      const parts = name.slice(5).split("__");
      return parts.length >= 2 ? `${parts[0]}:${parts.slice(1).join(".")}` : name;
    }
    return capitalizePhrase(name);
  }

  // Fall back to toolTitle or label
  if (workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
}

const GroupedWorkEntriesRow = memo(function GroupedWorkEntriesRow(props: {
  row: Extract<MessagesTimelineRow, { kind: "work-group" }>;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  expandedInlineDiff: ExpandedInlineDiffState;
  onToggleInlineDiff: (scope: "tool" | "turn", id: string) => void;
}) {
  const { row, expandedWorkGroups, onToggleWorkGroup, expandedInlineDiff, onToggleInlineDiff } =
    props;
  const groupId = row.id;
  const groupedEntries = row.groupedEntries;
  const isExpanded = expandedWorkGroups[groupId] ?? false;
  const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !isExpanded
      ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
      : groupedEntries;
  const hiddenCount = groupedEntries.length - visibleEntries.length;
  const showHeader = hasOverflow || groupedEntries.length > 1;

  return (
    <div className="rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
      {showHeader && (
        <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
          <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
            Operations ({groupedEntries.length})
          </p>
          {hasOverflow && (
            <button
              type="button"
              className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
              onClick={() => onToggleWorkGroup(groupId)}
            >
              {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
            </button>
          )}
        </div>
      )}
      <div className="space-y-0.5">
        {visibleEntries.map((workEntry) => (
          <SimpleWorkEntryRow
            key={`work-row:${workEntry.id}`}
            workEntry={workEntry}
            expandedInlineDiff={expandedInlineDiff}
            onToggleInlineDiff={onToggleInlineDiff}
          />
        ))}
      </div>
    </div>
  );
});

const StandaloneWorkEntryRow = memo(function StandaloneWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  expandedInlineDiff: ExpandedInlineDiffState;
  onToggleInlineDiff: (scope: "tool" | "turn", id: string) => void;
}) {
  return (
    <div className="rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
      <SimpleWorkEntryRow
        workEntry={props.workEntry}
        expandedInlineDiff={props.expandedInlineDiff}
        onToggleInlineDiff={props.onToggleInlineDiff}
      />
    </div>
  );
});

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  expandedInlineDiff: ExpandedInlineDiffState;
  onToggleInlineDiff: (scope: "tool" | "turn", id: string) => void;
}) {
  const { workEntry, expandedInlineDiff, onToggleInlineDiff } = props;

  // Agent tool calls get a specialized row with collapsible prompt
  if (workEntry.itemType === "collab_agent_tool_call") {
    return <AgentWorkEntryRow workEntry={workEntry} />;
  }

  if (workEntry.itemType === "file_change" && workEntry.inlineDiff) {
    return (
      <FileChangeWorkEntryRow
        workEntry={workEntry}
        expandedInlineDiff={expandedInlineDiff}
        onToggleInlineDiff={onToggleInlineDiff}
      />
    );
  }

  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const preview = workEntryPreview(workEntry);
  const toolInlineDiff = workEntry.inlineDiff;
  const isToolDiffExpanded =
    expandedInlineDiff?.scope === "tool" && expandedInlineDiff.id === workEntry.id;

  // Determine if preview should be monospace (commands, file paths, search patterns)
  const isMonoPreview =
    workEntry.itemType === "command_execution" ||
    workEntry.itemType === "file_read" ||
    workEntry.itemType === "file_change" ||
    workEntry.itemType === "search" ||
    Boolean(workEntry.command);

  // Exit code badge for commands
  const showExitCode =
    workEntry.itemType === "command_execution" && workEntry.exitCode !== undefined;
  const exitSuccess = workEntry.exitCode === 0;

  // Duration
  const durationLabel =
    workEntry.durationMs !== undefined ? formatDuration(workEntry.durationMs) : null;

  return (
    <div className="rounded-lg px-1 py-1">
      <div className="flex items-center gap-2 transition-[opacity,translate] duration-200">
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <p
            className={cn("truncate text-[11px] leading-5", workToneClass(workEntry.tone))}
            title={preview ? `${heading} – ${preview}` : heading}
          >
            <span className="text-foreground/80">{heading}</span>
            {preview && (
              <span
                className={cn("text-muted-foreground/55", isMonoPreview && "font-mono text-[10px]")}
              >
                {" – "}
                {preview}
              </span>
            )}
          </p>
        </div>
        {/* Right-side metadata badges */}
        <div className="flex shrink-0 items-center gap-1.5">
          {showExitCode && (
            <span
              className={cn(
                "inline-flex items-center rounded px-1 py-px text-[9px] font-medium leading-none",
                exitSuccess
                  ? "bg-emerald-500/10 text-emerald-400/80"
                  : "bg-rose-500/10 text-rose-400/80",
              )}
            >
              {exitSuccess ? "✓" : `exit ${workEntry.exitCode}`}
            </span>
          )}
          {durationLabel && (
            <span className="text-[9px] tabular-nums text-muted-foreground/40">
              {durationLabel}
            </span>
          )}
        </div>
      </div>
      {toolInlineDiff ? (
        <InlineToolDiffBlock
          inlineDiff={toolInlineDiff}
          expanded={isToolDiffExpanded}
          onToggle={() => onToggleInlineDiff("tool", workEntry.id)}
        />
      ) : null}
    </div>
  );
});

const FileChangeWorkEntryRow = memo(function FileChangeWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  expandedInlineDiff: ExpandedInlineDiffState;
  onToggleInlineDiff: (scope: "tool" | "turn", id: string) => void;
}) {
  const { workEntry, expandedInlineDiff, onToggleInlineDiff } = props;
  const filePath =
    workEntry.inlineDiff?.files[0]?.path ??
    workEntry.filePath ??
    workEntry.changedFiles?.[0] ??
    workEntry.detail ??
    null;
  const isToolDiffExpanded =
    expandedInlineDiff?.scope === "tool" && expandedInlineDiff.id === workEntry.id;

  return (
    <div className="rounded-lg px-1 py-1">
      <CompactDiffEntryRow icon={SquarePenIcon} label="FileChange" path={filePath} />
      <InlineToolDiffBlock
        inlineDiff={workEntry.inlineDiff!}
        expanded={isToolDiffExpanded}
        onToggle={() => onToggleInlineDiff("tool", workEntry.id)}
      />
    </div>
  );
});

const AgentWorkEntryRow = memo(function AgentWorkEntryRow(props: { workEntry: TimelineWorkEntry }) {
  const { workEntry } = props;
  const [isExpanded, setIsExpanded] = useState(false);
  const iconConfig = workToneIcon(workEntry.tone);
  const heading = toolWorkEntryHeading(workEntry);
  const preview = workEntryPreview(workEntry);
  const hasPrompt = Boolean(workEntry.agentPrompt);

  const durationLabel =
    workEntry.durationMs !== undefined ? formatDuration(workEntry.durationMs) : null;

  const handleToggle = useCallback(() => {
    if (hasPrompt) setIsExpanded((prev) => !prev);
  }, [hasPrompt]);

  return (
    <div className="rounded-lg px-1 py-1">
      <div
        role={hasPrompt ? "button" : undefined}
        tabIndex={hasPrompt ? 0 : undefined}
        onClick={handleToggle}
        onKeyDown={
          hasPrompt
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleToggle();
                }
              }
            : undefined
        }
        className={cn(
          "flex items-center gap-2 transition-[opacity,translate] duration-200",
          hasPrompt && "cursor-pointer rounded-md hover:bg-muted/30",
        )}
      >
        {hasPrompt ? (
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground/50 transition-transform duration-150",
              isExpanded && "rotate-90",
            )}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <BoxIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <p
            className={cn("truncate text-[11px] leading-5", workToneClass(workEntry.tone))}
            title={preview ? `${heading} – ${preview}` : heading}
          >
            <span className="text-foreground/80">{heading}</span>
            {preview && (
              <span className="text-muted-foreground/55">
                {" – "}
                {preview}
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {durationLabel && (
            <span className="text-[9px] tabular-nums text-muted-foreground/40">
              {durationLabel}
            </span>
          )}
        </div>
      </div>
      {isExpanded && workEntry.agentPrompt && (
        <div className="ml-8 mt-1.5 rounded-lg border border-border/30 bg-background/30 px-3 py-2">
          <p className="mb-1 text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
            Prompt
          </p>
          <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/70">
            {workEntry.agentPrompt}
          </p>
        </div>
      )}
    </div>
  );
});

const InlineToolDiffBlock = memo(function InlineToolDiffBlock(props: {
  inlineDiff: ToolInlineDiffSummary;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { inlineDiff, expanded, onToggle } = props;
  const previewContent = useMemo(
    () =>
      inlineDiff.availability === "exact_patch"
        ? getCompactDiffPreviewContent(inlineDiff.unifiedDiff, `tool-inline:${inlineDiff.id}`)
        : null,
    [inlineDiff.availability, inlineDiff.id, inlineDiff.unifiedDiff],
  );
  const showExpandBar =
    inlineDiff.availability === "exact_patch" && (expanded || previewContent?.hasOverflow === true);

  return (
    <div className="mt-1">
      <CompactDiffCard
        header={
          <CompactDiffHeader
            label="Tool changes"
            fileCount={inlineDiff.files.length}
            additions={inlineDiff.additions}
            deletions={inlineDiff.deletions}
          />
        }
        expanded={expanded}
        showExpandBar={showExpandBar}
        onToggleExpand={showExpandBar ? onToggle : undefined}
      >
        {inlineDiff.availability === "exact_patch" ? (
          <CompactDiffPreview
            content={previewContent}
            expanded={expanded}
            emptyLabel="No patch available for this tool call."
          />
        ) : (
          <CompactDiffSummaryFallback
            files={inlineDiff.files}
            note="Patch unavailable for this tool call."
          />
        )}
      </CompactDiffCard>
    </div>
  );
});

const InlineTurnDiffBlock = memo(function InlineTurnDiffBlock(props: {
  threadId: ThreadId | null;
  turnSummary: TurnDiffSummary;
  expandedInlineDiff: ExpandedInlineDiffState;
  onToggleInlineDiff: (scope: "tool" | "turn", id: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const { threadId, turnSummary, expandedInlineDiff, onToggleInlineDiff, onOpenTurnDiff } = props;
  const expanded =
    expandedInlineDiff?.scope === "turn" && expandedInlineDiff.id === turnSummary.turnId;
  const summaryStat = summarizeTurnDiffStats(turnSummary.files);
  const hasStats = summaryStat.additions > 0 || summaryStat.deletions > 0;
  const summaryLabel =
    turnSummary.provenance === "agent"
      ? turnSummary.coverage === "partial"
        ? "Turn changes (partial)"
        : "Turn changes"
      : "Workspace changes during turn";
  const turnDiffQuery = useQuery(
    agentDiffQueryOptions({
      threadId,
      turnId: turnSummary.turnId,
      cacheScope: `timeline:turn:${turnSummary.turnId}`,
      enabled: true,
    }),
  );
  const patch = turnDiffQuery.data?.diff;
  const previewContent = useMemo(
    () => getCompactDiffPreviewContent(patch, `turn-inline:${turnSummary.turnId}`),
    [patch, turnSummary.turnId],
  );
  const diffComplexity = classifyDiffComplexity(summarizeDiffFileSummaries(turnSummary.files));
  const showExpandBar =
    !turnDiffQuery.isLoading &&
    Boolean(previewContent) &&
    (expanded || previewContent?.hasOverflow === true);

  return (
    <div className="mt-2">
      <CompactDiffCard
        tone="turn"
        header={
          <CompactDiffHeader
            label={summaryLabel}
            fileCount={turnSummary.files.length}
            additions={hasStats ? summaryStat.additions : undefined}
            deletions={hasStats ? summaryStat.deletions : undefined}
            actions={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="rounded-md border border-border/45 bg-background/24 text-muted-foreground/60 hover:bg-background/40 hover:text-foreground/80"
                onClick={() => onOpenTurnDiff(turnSummary.turnId, turnSummary.files[0]?.path)}
                aria-label="Open in diff panel"
                title="Open in diff panel"
              >
                <Columns2Icon className="size-3.5" />
              </Button>
            }
          />
        }
        expanded={expanded}
        showExpandBar={showExpandBar}
        onToggleExpand={
          showExpandBar ? () => onToggleInlineDiff("turn", turnSummary.turnId) : undefined
        }
      >
        {turnDiffQuery.isLoading ? (
          <p className="px-3 pb-3 pt-1.5 text-[11px] leading-5 text-muted-foreground/64">
            {getDiffLoadingLabel("Loading diff…", diffComplexity)}
          </p>
        ) : patch && patch.trim().length > 0 ? (
          <CompactDiffPreview
            content={previewContent}
            expanded={expanded}
            emptyLabel="No agent patch available for this turn."
          />
        ) : (
          <p className="px-3 pb-3 pt-1.5 text-[11px] leading-5 text-muted-foreground/64">
            No agent patch available for this turn.
          </p>
        )}
      </CompactDiffCard>
    </div>
  );
});
