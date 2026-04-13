import { memo, useCallback, useRef, type ReactNode } from "react";
import { BoxIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { formatDuration, type SubagentGroup, type WorkLogEntry } from "../../session-logic";
import { statusPresentation } from "./backgroundStatusPresentation";
import { SUBAGENT_ENTRIES_MAX_HEIGHT_PX } from "./MessagesTimeline.logic";
import { LazySubagentEntries } from "./LazySubagentEntries";
import { SubagentHeading } from "./SubagentHeading";

interface SubagentSectionProps {
  threadId: string | null;
  groups: ReadonlyArray<SubagentGroup>;
  expandedGroupId: string | null;
  onToggle: (groupId: string) => void;
  renderWorkEntry: (entry: WorkLogEntry) => ReactNode;
  nowIso: string;
  sectionLabel?: string | undefined;
}

export const SubagentSection = memo(function SubagentSection(props: SubagentSectionProps) {
  const { threadId, groups, expandedGroupId, onToggle, renderWorkEntry, nowIso, sectionLabel } =
    props;

  return (
    <div className="rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
      <div className="mb-1.5 px-0.5">
        <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
          {sectionLabel ?? `Subagents (${groups.length})`}
        </p>
      </div>
      <div className="space-y-1">
        {groups.map((group) => (
          <SubagentGroupRow
            key={group.groupId}
            threadId={threadId}
            group={group}
            isExpanded={expandedGroupId === group.groupId}
            onToggle={onToggle}
            renderWorkEntry={renderWorkEntry}
            nowIso={nowIso}
          />
        ))}
      </div>
    </div>
  );
});

const SubagentGroupRow = memo(function SubagentGroupRow(props: {
  threadId: string | null;
  group: SubagentGroup;
  isExpanded: boolean;
  onToggle: (groupId: string) => void;
  renderWorkEntry: (entry: WorkLogEntry) => ReactNode;
  nowIso: string;
}) {
  const { threadId, group, isExpanded, onToggle, renderWorkEntry, nowIso } = props;

  const handleToggle = useCallback(() => {
    onToggle(group.groupId);
  }, [group.groupId, onToggle]);

  const {
    icon: StatusIcon,
    className: statusColor,
    showLabel: showStatusLabel,
  } = statusPresentation(group.status);
  const maxDurationRef = useRef(0);

  const rawDurationMs = group.completedAt
    ? new Date(group.completedAt).getTime() - new Date(group.startedAt).getTime()
    : group.status === "running"
      ? new Date(nowIso).getTime() - new Date(group.startedAt).getTime()
      : undefined;

  if (rawDurationMs !== undefined && rawDurationMs > maxDurationRef.current) {
    maxDurationRef.current = rawDurationMs;
  }
  const durationMs =
    rawDurationMs !== undefined ? Math.max(rawDurationMs, maxDurationRef.current) : undefined;

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
        <span className="min-w-0 flex-1 truncate text-[11px] leading-5">
          <SubagentHeading
            agentType={group.agentType}
            agentModel={group.agentModel}
            agentDescription={group.agentDescription}
            agentPrompt={group.agentPrompt}
            fallbackLabel={group.label}
          />
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className={cn("flex items-center gap-0.5 text-[9px]", statusColor)}>
            <StatusIcon className={cn("size-2.5", group.status === "running" && "animate-spin")} />
            {showStatusLabel ? group.status : null}
          </span>
          {durationMs !== undefined && durationMs > 0 ? (
            <span className="text-[9px] tabular-nums text-muted-foreground/40">
              {formatDuration(durationMs)}
            </span>
          ) : null}
        </div>
      </button>
      {isExpanded ? (
        <div className="ml-5 border-l border-border/30 pb-2 pl-3">
          <div className="pt-1">
            <LazySubagentEntries
              threadId={threadId}
              childProviderThreadId={group.childProviderThreadId}
              expanded={isExpanded}
              isRunning={group.status === "running"}
              fallbackEntries={group.entries}
              renderEntry={renderWorkEntry}
              maxHeightPx={SUBAGENT_ENTRIES_MAX_HEIGHT_PX}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
});
