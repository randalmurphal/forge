import { ThreadId } from "@forgetools/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import { ensureNativeApi } from "~/nativeApi";
import { debugLog, describeWebDebugError, isWebDebugEnabled } from "~/debug";
import { type WorkLogEntry, deriveWorkLogEntries } from "../../session-logic";

const DEBUG_BACKGROUND_TASKS = isWebDebugEnabled("background");

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
    // A failing feed fetch currently means either the websocket path or the renderer state is wrong.
    // Retrying just thrashes the panel and obscures the first useful error.
    retry: false,
    staleTime: shouldPoll ? 0 : Number.POSITIVE_INFINITY,
    refetchInterval: shouldPoll ? 1_000 : false,
    queryFn: async () =>
      ensureNativeApi().orchestration.getSubagentActivityFeed({
        threadId: ThreadId.makeUnsafe(props.threadId!),
        childProviderThreadId: props.childProviderThreadId,
      }),
  });

  useEffect(() => {
    if (!DEBUG_BACKGROUND_TASKS || !shouldFetch) {
      return;
    }

    debugLog({
      topic: "background",
      source: "LazySubagentEntries",
      label: "subagent.feed.request",
      details: {
        threadId: props.threadId,
        childProviderThreadId: props.childProviderThreadId,
        isRunning: props.isRunning,
        fallbackEntryCount: props.fallbackEntries?.length ?? 0,
      },
    });
  }, [
    props.childProviderThreadId,
    props.fallbackEntries?.length,
    props.isRunning,
    props.threadId,
    shouldFetch,
  ]);

  useEffect(() => {
    if (!DEBUG_BACKGROUND_TASKS || !feedQuery.data) {
      return;
    }

    debugLog({
      topic: "background",
      source: "LazySubagentEntries",
      label: "subagent.feed.success",
      details: {
        threadId: props.threadId,
        childProviderThreadId: props.childProviderThreadId,
        activityCount: feedQuery.data.activities.length,
        omittedActivityCount: feedQuery.data.omittedActivityCount,
      },
    });
  }, [feedQuery.data, props.childProviderThreadId, props.threadId]);

  useEffect(() => {
    if (!DEBUG_BACKGROUND_TASKS || !feedQuery.isError) {
      return;
    }

    debugLog({
      topic: "background",
      source: "LazySubagentEntries",
      label: "subagent.feed.error",
      details: {
        threadId: props.threadId,
        childProviderThreadId: props.childProviderThreadId,
        error: describeWebDebugError(feedQuery.error),
      },
    });
  }, [feedQuery.error, feedQuery.isError, props.childProviderThreadId, props.threadId]);

  const remoteEntries = useMemo(() => {
    if (!feedQuery.data) {
      return null;
    }
    return deriveWorkLogEntries(feedQuery.data.activities, undefined).filter(
      (entry) => entry.activityKind !== "task.started" && entry.activityKind !== "task.completed",
    );
  }, [feedQuery.data]);
  const entries = remoteEntries ?? [...(props.fallbackEntries ?? [])];
  const fallbackStateLabel = props.isRunning ? "No recorded actions yet" : "No recorded actions";

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
      <div className="px-3 py-2 text-[10px] italic text-muted-foreground/45">
        {fallbackStateLabel}
        {DEBUG_BACKGROUND_TASKS && feedQuery.error ? (
          <div className="mt-1 font-mono not-italic text-[9px] text-destructive/65">
            {feedQuery.error instanceof Error ? feedQuery.error.message : String(feedQuery.error)}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="px-3 py-2 text-[10px] italic text-muted-foreground/45">
      {fallbackStateLabel}
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
