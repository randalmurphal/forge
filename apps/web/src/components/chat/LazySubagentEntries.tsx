import { ThreadId } from "@forgetools/contracts";
import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";

import { ensureNativeApi } from "~/nativeApi";
import { type WorkLogEntry, deriveWorkLogEntries } from "../../session-logic";

export const LazySubagentEntries = memo(function LazySubagentEntries(props: {
  threadId: string | null;
  childProviderThreadId: string;
  expanded: boolean;
  isRunning: boolean;
  fallbackEntries?: ReadonlyArray<WorkLogEntry> | undefined;
  renderEntry: (entry: WorkLogEntry) => ReactNode;
  maxHeightPx: number;
}) {
  const canQuery = typeof window !== "undefined";
  const shouldPoll = props.expanded && props.isRunning;
  const shouldFetch = props.expanded && canQuery && props.threadId !== null;
  const feedQuery = useQuery({
    queryKey: [
      "orchestration",
      "subagent-activity-feed",
      props.threadId,
      props.childProviderThreadId,
    ],
    enabled: shouldFetch,
    staleTime: shouldPoll ? 0 : Number.POSITIVE_INFINITY,
    refetchInterval: shouldPoll ? 1_000 : false,
    queryFn: async () =>
      ensureNativeApi().orchestration.getSubagentActivityFeed({
        threadId: ThreadId.makeUnsafe(props.threadId!),
        childProviderThreadId: props.childProviderThreadId,
      }),
  });

  const remoteEntries = useMemo(() => {
    if (!feedQuery.data) {
      return null;
    }
    return deriveWorkLogEntries(feedQuery.data.activities, undefined).filter(
      (entry) => entry.activityKind !== "task.started" && entry.activityKind !== "task.completed",
    );
  }, [feedQuery.data]);
  const entries = remoteEntries ?? [...(props.fallbackEntries ?? [])];

  if (!props.expanded) {
    return null;
  }

  if (entries.length > 0) {
    return (
      <SubagentEntriesScrollArea
        entries={entries}
        omittedCount={feedQuery.data?.omittedActivityCount ?? 0}
        renderEntry={props.renderEntry}
        maxHeightPx={props.maxHeightPx}
      />
    );
  }

  if (feedQuery.isPending) {
    return (
      <div className="px-3 py-2 text-[10px] italic text-muted-foreground/45">Loading activity…</div>
    );
  }

  if (feedQuery.isError) {
    return (
      <div className="px-3 py-2 text-[10px] italic text-destructive/70">
        Failed to load recorded actions
      </div>
    );
  }

  return (
    <div className="px-3 py-2 text-[10px] italic text-muted-foreground/45">
      {props.isRunning ? "No recorded actions yet" : "No recorded actions"}
    </div>
  );
});

const SubagentEntriesScrollArea = memo(function SubagentEntriesScrollArea(props: {
  entries: ReadonlyArray<WorkLogEntry>;
  omittedCount: number;
  renderEntry: (entry: WorkLogEntry) => ReactNode;
  maxHeightPx: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (isAtBottomRef.current && element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [props.entries.length]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.clientHeight - element.scrollTop;
    isAtBottomRef.current = distanceFromBottom <= 32;
  }, []);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="overflow-y-auto px-2 py-2 [scrollbar-width:thin]"
      style={{ maxHeight: props.maxHeightPx }}
    >
      {props.omittedCount > 0 ? (
        <p className="px-1 pb-2 text-[10px] italic text-muted-foreground/45">
          {props.omittedCount} earlier actions omitted
        </p>
      ) : null}
      <div className="space-y-1">
        {props.entries.map((entry) => (
          <div key={entry.id}>{props.renderEntry(entry)}</div>
        ))}
      </div>
    </div>
  );
});
