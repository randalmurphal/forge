import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BoxIcon, ChevronRightIcon, TerminalIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { statusPresentation, workEntryIcon } from "./backgroundStatusPresentation";
import { LazyCommandOutput } from "./LazyCommandOutput";
import { LazySubagentEntries } from "./LazySubagentEntries";
import { deriveSubagentPresentation } from "./subagentPresentation";
import {
  deriveBackgroundCommandStatus,
  formatDuration,
  type BackgroundTrayState,
  type SubagentGroup,
  type WorkLogEntry,
} from "../../session-logic";

interface ComposerBackgroundTaskTrayProps {
  threadId: string;
  state: BackgroundTrayState;
  nowIso: string;
}

type BackgroundTrayTask =
  | {
      id: string;
      kind: "subagent";
      createdAt: string;
      group: SubagentGroup;
    }
  | {
      id: string;
      kind: "command";
      createdAt: string;
      entry: WorkLogEntry;
    };

export const ComposerBackgroundTaskTray = memo(function ComposerBackgroundTaskTray(
  props: ComposerBackgroundTaskTrayProps,
) {
  const taskCount = props.state.subagentGroups.length + props.state.commandEntries.length;
  const previousTaskCountRef = useRef(taskCount);
  const [isExpanded, setIsExpanded] = useState(() => !props.state.defaultCollapsed);
  const [entered, setEntered] = useState(false);
  const [expandedTaskIds, setExpandedTaskIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const previousTaskCount = previousTaskCountRef.current;
    previousTaskCountRef.current = taskCount;
    if (taskCount > 0 && previousTaskCount === 0) {
      setIsExpanded(!props.state.defaultCollapsed);
      setExpandedTaskIds({});
    }
  }, [props.state.defaultCollapsed, taskCount]);

  useEffect(() => {
    setEntered(false);
    const frame = window.requestAnimationFrame(() => {
      setEntered(true);
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [taskCount]);

  const tasks = useMemo<BackgroundTrayTask[]>(
    () =>
      [
        ...props.state.subagentGroups.map((group) => ({
          id: `subagent:${group.groupId}`,
          kind: "subagent" as const,
          createdAt: group.startedAt,
          group,
        })),
        ...props.state.commandEntries.map((entry) => ({
          id: `command:${entry.id}`,
          kind: "command" as const,
          createdAt: entry.startedAt ?? entry.createdAt,
          entry,
        })),
      ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
    [props.state.commandEntries, props.state.subagentGroups],
  );

  const onToggleHeader = useCallback(() => {
    setIsExpanded((current) => !current);
  }, []);

  const onToggleTask = useCallback((taskId: string) => {
    setExpandedTaskIds((current) => ({
      ...current,
      [taskId]: !(current[taskId] ?? false),
    }));
  }, []);

  if (taskCount === 0) {
    return null;
  }

  return (
    <div
      key={props.threadId}
      className={cn(
        "overflow-hidden border-border/65 border-b bg-card transition-[opacity,transform] duration-200",
        entered ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
      )}
    >
      <button
        type="button"
        onClick={onToggleHeader}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/20 sm:px-4"
      >
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground/50 transition-transform duration-150",
            isExpanded && "rotate-90",
          )}
        />
        <span className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
          Background
        </span>
        <span className="rounded px-1 text-[10px] font-medium text-primary/85 bg-primary/15">
          {taskCount}
        </span>
        {props.state.hasRunningTasks ? (
          <span className="h-1.5 w-1.5 rounded-full bg-primary/80 animate-pulse" />
        ) : null}
      </button>

      {isExpanded ? (
        <div className="border-border/50 border-t px-2 py-2 sm:px-3">
          <div className="space-y-1">
            {tasks.map((task) =>
              task.kind === "subagent" ? (
                <BackgroundSubagentTaskRow
                  key={task.id}
                  threadId={props.threadId}
                  group={task.group}
                  isExpanded={expandedTaskIds[task.id] ?? false}
                  nowIso={props.nowIso}
                  onToggle={() => onToggleTask(task.id)}
                />
              ) : (
                <BackgroundCommandTaskRow
                  key={task.id}
                  threadId={props.threadId}
                  entry={task.entry}
                  isExpanded={expandedTaskIds[task.id] ?? false}
                  nowIso={props.nowIso}
                  onToggle={() => onToggleTask(task.id)}
                />
              ),
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
});

const BackgroundCommandTaskRow = memo(function BackgroundCommandTaskRow(props: {
  threadId: string;
  entry: WorkLogEntry;
  isExpanded: boolean;
  nowIso: string;
  onToggle: () => void;
}) {
  const status = deriveBackgroundCommandStatus(props.entry);
  const hasOutput = Boolean(props.entry.hasOutput || props.entry.output);
  const elapsed = formatTrayTaskElapsed(
    props.entry.startedAt ?? props.entry.createdAt,
    props.entry.backgroundCompletedAt ?? props.entry.completedAt ?? props.entry.createdAt,
    status,
    props.nowIso,
  );
  const heading = props.entry.toolTitle ?? props.entry.toolName ?? "Command";
  const preview = props.entry.command ?? props.entry.detail ?? null;

  return (
    <div className="rounded-lg border border-border/30 bg-background/20">
      <button
        type="button"
        onClick={hasOutput ? props.onToggle : undefined}
        aria-expanded={hasOutput ? props.isExpanded : undefined}
        className={cn(
          "flex w-full items-center gap-2 px-2 py-2 text-left transition-colors",
          hasOutput ? "hover:bg-muted/30" : "cursor-default",
        )}
      >
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground/50 transition-transform duration-150",
            props.isExpanded && "rotate-90",
            !hasOutput && "opacity-35",
          )}
        />
        <span className="flex size-4 shrink-0 items-center justify-center text-foreground/70">
          <TerminalIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] text-foreground/80">
            <span>{heading}</span>
            {preview ? (
              <span className="font-mono text-[10px] text-muted-foreground/55">
                {" – "}
                {preview}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <BackgroundTaskStatusBadge status={status} />
          {elapsed ? (
            <span className="text-[9px] tabular-nums text-muted-foreground/40">{elapsed}</span>
          ) : null}
        </div>
      </button>
      {hasOutput && props.isExpanded ? (
        <div className="ml-7 mr-2 mb-2">
          <LazyCommandOutput
            threadId={props.threadId}
            entry={props.entry}
            expanded={props.isExpanded}
            maxHeightPx={240}
            label="Output"
          />
        </div>
      ) : null}
    </div>
  );
});

const BackgroundSubagentTaskRow = memo(function BackgroundSubagentTaskRow(props: {
  threadId: string;
  group: SubagentGroup;
  isExpanded: boolean;
  nowIso: string;
  onToggle: () => void;
}) {
  const elapsed = formatTrayTaskElapsed(
    props.group.startedAt,
    props.group.completedAt ?? props.group.startedAt,
    props.group.status,
    props.nowIso,
  );
  const presentation = deriveSubagentPresentation({
    agentModel: props.group.agentModel,
    agentDescription: props.group.agentDescription,
    agentPrompt: props.group.agentPrompt,
    fallbackLabel: props.group.label,
  });
  const renderEntry = useCallback(
    (entry: WorkLogEntry) => <TraySubagentWorkEntryRow threadId={props.threadId} entry={entry} />,
    [props.threadId],
  );

  return (
    <div className="rounded-lg border border-border/30 bg-background/20">
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.isExpanded}
        className="flex w-full items-center gap-2 px-2 py-2 text-left transition-colors hover:bg-muted/30"
      >
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground/50 transition-transform duration-150",
            props.isExpanded && "rotate-90",
          )}
        />
        <span className="flex size-4 shrink-0 items-center justify-center text-foreground/70">
          <BoxIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] text-foreground/80">{presentation.heading}</p>
          {presentation.preview ? (
            <p className="truncate text-[10px] text-muted-foreground/55">{presentation.preview}</p>
          ) : (
            <p className="truncate text-[10px] text-muted-foreground/45">Agent</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <BackgroundTaskStatusBadge status={props.group.status} />
          {elapsed ? (
            <span className="text-[9px] tabular-nums text-muted-foreground/40">{elapsed}</span>
          ) : null}
        </div>
      </button>
      {props.isExpanded ? (
        <div className="ml-7 mr-2 mb-2 rounded-lg border border-border/35 bg-background/35">
          <div className="border-border/20 border-b px-3 py-2">
            <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
              Activity
            </p>
          </div>
          <LazySubagentEntries
            threadId={props.threadId}
            childProviderThreadId={props.group.childProviderThreadId}
            expanded={props.isExpanded}
            isRunning={props.group.status === "running"}
            fallbackEntries={props.group.entries}
            renderEntry={renderEntry}
            maxHeightPx={240}
          />
        </div>
      ) : null}
    </div>
  );
});

const TraySubagentWorkEntryRow = memo(function TraySubagentWorkEntryRow(props: {
  threadId: string | null;
  entry: WorkLogEntry;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isCommand = props.entry.itemType === "command_execution";
  const hasOutput = isCommand && Boolean(props.entry.hasOutput || props.entry.output);
  const EntryIcon = isCommand ? TerminalIcon : workEntryIcon(props.entry);
  const preview = props.entry.command ?? props.entry.filePath ?? props.entry.detail ?? null;
  const heading = props.entry.toolTitle ?? props.entry.toolName ?? props.entry.label;

  return (
    <div className="rounded-md px-1 py-1">
      <button
        type="button"
        onClick={hasOutput ? () => setIsExpanded((current) => !current) : undefined}
        aria-expanded={hasOutput ? isExpanded : undefined}
        className={cn(
          "flex w-full items-center gap-2 text-left",
          hasOutput ? "hover:bg-muted/20" : "cursor-default",
        )}
      >
        {isCommand ? (
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground/50 transition-transform duration-150",
              isExpanded && "rotate-90",
              !hasOutput && "opacity-35",
            )}
          />
        ) : null}
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/70">
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] text-foreground/75">
            <span>{heading}</span>
            {preview ? (
              <span
                className={cn("text-muted-foreground/50", isCommand && "font-mono text-[10px]")}
              >
                {" – "}
                {preview}
              </span>
            ) : null}
          </p>
        </div>
      </button>
      {hasOutput && isExpanded ? (
        <div className="ml-7 mt-1">
          <LazyCommandOutput
            threadId={props.threadId}
            entry={props.entry}
            expanded={isExpanded}
            maxHeightPx={240}
          />
        </div>
      ) : null}
    </div>
  );
});

const BackgroundTaskStatusBadge = memo(function BackgroundTaskStatusBadge(props: {
  status: "running" | "completed" | "failed";
}) {
  const { icon: StatusIcon, className, showLabel } = statusPresentation(props.status);
  return (
    <span className={cn("inline-flex items-center gap-1 text-[9px]", className)}>
      <StatusIcon className={cn("size-2.5", props.status === "running" && "animate-spin")} />
      {showLabel ? props.status : null}
    </span>
  );
});

function formatTrayTaskElapsed(
  startedAt: string,
  completedAt: string,
  status: "running" | "completed" | "failed",
  nowIso: string,
): string | null {
  const startedAtMs = Date.parse(startedAt);
  const completedAtMs = Date.parse(status === "running" ? nowIso : completedAt);
  if (Number.isNaN(startedAtMs) || Number.isNaN(completedAtMs) || completedAtMs < startedAtMs) {
    return null;
  }
  return formatDuration(completedAtMs - startedAtMs);
}
