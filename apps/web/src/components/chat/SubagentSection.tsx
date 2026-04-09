import { memo, useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import {
  AlertCircleIcon,
  BoxIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  LoaderIcon,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { formatDuration, type SubagentGroup, type WorkLogEntry } from "../../session-logic";
import { SUBAGENT_ENTRIES_MAX_HEIGHT_PX } from "./MessagesTimeline.logic";

interface SubagentSectionProps {
  groups: ReadonlyArray<SubagentGroup>;
  expandedTaskId: string | null;
  onToggle: (taskId: string) => void;
  renderWorkEntry: (entry: WorkLogEntry) => ReactNode;
}

export const SubagentSection = memo(function SubagentSection(props: SubagentSectionProps) {
  const { groups, expandedTaskId, onToggle, renderWorkEntry } = props;

  return (
    <div className="rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
      <div className="mb-1.5 px-0.5">
        <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
          Subagents ({groups.length})
        </p>
      </div>
      <div className="space-y-1">
        {groups.map((group) => (
          <SubagentGroupRow
            key={group.taskId}
            group={group}
            isExpanded={expandedTaskId === group.taskId}
            onToggle={onToggle}
            renderWorkEntry={renderWorkEntry}
          />
        ))}
      </div>
    </div>
  );
});

const SubagentGroupRow = memo(function SubagentGroupRow(props: {
  group: SubagentGroup;
  isExpanded: boolean;
  onToggle: (taskId: string) => void;
  renderWorkEntry: (entry: WorkLogEntry) => ReactNode;
}) {
  const { group, isExpanded, onToggle, renderWorkEntry } = props;

  const handleToggle = useCallback(() => {
    onToggle(group.taskId);
  }, [onToggle, group.taskId]);

  const StatusIcon = statusIcon(group.status);
  const statusColor = statusColorClass(group.status);

  const durationMs = group.completedAt
    ? new Date(group.completedAt).getTime() - new Date(group.startedAt).getTime()
    : undefined;

  return (
    <div className="rounded-lg border border-border/30 bg-background/30">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={isExpanded}
        aria-label={`Toggle ${group.label} details`}
        className="flex w-full items-center gap-2 px-2 py-2 text-left transition-colors hover:bg-muted/30"
      >
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground/50 transition-transform duration-150",
            isExpanded && "rotate-90",
          )}
        />
        <span className="flex size-4 shrink-0 items-center justify-center text-foreground/70">
          <BoxIcon className="size-3" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/80">
          {group.label}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className={cn("flex items-center gap-0.5 text-[9px]", statusColor)}>
            <StatusIcon className={cn("size-2.5", group.status === "running" && "animate-spin")} />
            {group.status}
          </span>
          {durationMs !== undefined && durationMs > 0 && (
            <span className="text-[9px] tabular-nums text-muted-foreground/40">
              {formatDuration(durationMs)}
            </span>
          )}
        </div>
      </button>
      {isExpanded && group.entries.length > 0 && (
        <SubagentEntriesScrollArea entries={group.entries} renderWorkEntry={renderWorkEntry} />
      )}
      {isExpanded && group.entries.length === 0 && (
        <div className="px-4 pb-2">
          <p className="text-[10px] italic text-muted-foreground/40">No recorded actions</p>
        </div>
      )}
    </div>
  );
});

const SubagentEntriesScrollArea = memo(function SubagentEntriesScrollArea(props: {
  entries: ReadonlyArray<WorkLogEntry>;
  renderWorkEntry: (entry: WorkLogEntry) => ReactNode;
}) {
  const { entries, renderWorkEntry } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (isAtBottomRef.current && el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries.length]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    isAtBottomRef.current = distanceFromBottom <= 32;
  }, []);

  return (
    <div className="ml-5 border-l border-border/30 pb-2 pl-3">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="overflow-y-auto pt-1"
        style={{ maxHeight: SUBAGENT_ENTRIES_MAX_HEIGHT_PX }}
      >
        <div className="space-y-0.5">
          {entries.map((entry) => (
            <div key={entry.id}>{renderWorkEntry(entry)}</div>
          ))}
        </div>
      </div>
    </div>
  );
});

function statusIcon(status: SubagentGroup["status"]) {
  switch (status) {
    case "running":
      return LoaderIcon;
    case "completed":
      return CheckCircle2Icon;
    case "failed":
      return AlertCircleIcon;
  }
}

function statusColorClass(status: SubagentGroup["status"]): string {
  switch (status) {
    case "running":
      return "text-primary/80";
    case "completed":
      return "text-success/80";
    case "failed":
      return "text-destructive/80";
  }
}
