import { EventId, ProviderItemId, ThreadId } from "@forgetools/contracts";
import { useQuery } from "@tanstack/react-query";
import { memo } from "react";

import { ensureNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import type { WorkLogEntry } from "../../session-logic";
import { CommandOutputPanel } from "./CommandOutputPanel";

export const LazyCommandOutput = memo(function LazyCommandOutput(props: {
  threadId: string | null;
  entry: Pick<
    WorkLogEntry,
    "id" | "toolCallId" | "output" | "hasOutput" | "itemStatus" | "itemType"
  >;
  expanded: boolean;
  maxHeightPx: number;
  label?: string | undefined;
  className?: string | undefined;
}) {
  const canQuery = typeof window !== "undefined";
  const shouldPoll = props.expanded && props.entry.itemStatus === "inProgress";
  const shouldFetch =
    props.expanded &&
    canQuery &&
    props.threadId !== null &&
    props.entry.itemType === "command_execution" &&
    (props.entry.hasOutput || shouldPoll) &&
    (props.entry.output === undefined || shouldPoll);
  const outputQuery = useQuery({
    queryKey: [
      "orchestration",
      "command-output",
      props.threadId,
      props.entry.id,
      props.entry.toolCallId ?? null,
    ],
    enabled: shouldFetch,
    staleTime: shouldPoll ? 0 : Number.POSITIVE_INFINITY,
    refetchInterval: shouldPoll ? 1_000 : false,
    queryFn: async () =>
      ensureNativeApi().orchestration.getCommandOutput({
        threadId: ThreadId.makeUnsafe(props.threadId!),
        activityId: EventId.makeUnsafe(props.entry.id),
        ...(props.entry.toolCallId
          ? { toolCallId: ProviderItemId.makeUnsafe(props.entry.toolCallId) }
          : {}),
      }),
  });

  if (!props.expanded) {
    return null;
  }

  const output = props.entry.output ?? outputQuery.data?.output ?? null;
  if (output) {
    const notice =
      outputQuery.data && outputQuery.data.omittedLineCount > 0
        ? `${outputQuery.data.omittedLineCount} earlier lines omitted`
        : undefined;
    return (
      <CommandOutputPanel
        output={output}
        maxHeightPx={props.maxHeightPx}
        label={props.label}
        notice={notice}
        className={props.className}
      />
    );
  }

  if (outputQuery.isPending) {
    return (
      <CommandOutputStatePanel className={props.className} label={props.label}>
        Loading output…
      </CommandOutputStatePanel>
    );
  }

  if (outputQuery.isError) {
    return (
      <CommandOutputStatePanel className={props.className} label={props.label}>
        Failed to load output
      </CommandOutputStatePanel>
    );
  }

  return null;
});

const CommandOutputStatePanel = memo(function CommandOutputStatePanel(props: {
  children: string;
  label?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <div className={cn("rounded-lg border border-border/35 bg-background/35", props.className)}>
      <div className="border-border/20 border-b px-3 py-2">
        <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
          {props.label ?? "Output"}
        </p>
      </div>
      <div className="px-3 py-2 font-mono text-[11px] leading-[1.5] text-muted-foreground/70">
        {props.children}
      </div>
    </div>
  );
});
