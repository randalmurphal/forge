import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { cva } from "class-variance-authority";
import {
  AlertCircleIcon,
  ArrowRightLeftIcon,
  MessagesSquareIcon,
  SendHorizonalIcon,
  SquareTerminalIcon,
  StopCircleIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PhaseRunId, type ThreadId } from "@forgetools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useStore } from "../store";
import { useProjectById, useThreadById } from "../storeSelectors";
import {
  channelInterveneMutationOptions,
  useChannelMessages,
  useChannelStore,
  useThreadChannel,
} from "../stores/channelStore";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { getWsRpcClient } from "../wsRpcClient";
import { cn } from "../lib/utils";
import ChatMarkdown from "./ChatMarkdown";
import {
  buildChannelViewModel,
  isChannelContainerThread,
  shouldFocusChannelIntervention,
  shouldToggleChannelSplitView,
} from "./ChannelView.logic";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { SidebarTrigger } from "./ui/sidebar";
import { Textarea } from "./ui/textarea";

const statusBadgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.08em]",
  {
    variants: {
      status: {
        open: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        concluded: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        closed: "border-zinc-500/25 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
      },
    },
  },
);

const participantBadgeVariants = cva(
  "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
  {
    variants: {
      tone: {
        sky: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
        amber: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        emerald: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        rose: "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300",
        human: "border-primary/20 bg-primary/8 text-foreground",
        system: "border-zinc-500/20 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
      },
    },
  },
);

const messageCardVariants = cva("rounded-2xl border px-4 py-3 shadow-xs", {
  variants: {
    tone: {
      sky: "border-sky-500/20 bg-sky-500/8",
      amber: "border-amber-500/20 bg-amber-500/8",
      emerald: "border-emerald-500/20 bg-emerald-500/8",
      rose: "border-rose-500/20 bg-rose-500/8",
      human: "border-primary/18 bg-primary/8",
      system: "border-zinc-500/18 bg-zinc-500/8 text-muted-foreground",
    },
  },
});

const transcriptPaneVariants = cva("rounded-2xl border bg-card/75", {
  variants: {
    tone: {
      sky: "border-sky-500/16",
      amber: "border-amber-500/16",
      emerald: "border-emerald-500/16",
      rose: "border-rose-500/16",
      human: "border-primary/16",
      system: "border-border/70",
    },
  },
});

function formatTurnCounter(turnCount: number, maxTurns: number | null): string {
  return maxTurns === null ? `Turn ${turnCount}` : `Turn ${turnCount}/${maxTurns}`;
}

function TranscriptPane(props: {
  pane: ReturnType<typeof buildChannelViewModel>["transcriptPanes"][number];
  markdownCwd: string | undefined;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  return (
    <section className={transcriptPaneVariants({ tone: props.pane.tone })}>
      <header className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div className="min-w-0">
          <button
            type="button"
            className="truncate text-left text-sm font-semibold text-foreground transition-colors hover:text-primary"
            onClick={() => props.onOpenThread(props.pane.threadId)}
          >
            {props.pane.title}
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
            {props.pane.roleLabel ? <span>{props.pane.roleLabel}</span> : null}
            {props.pane.providerLabel ? <span>{props.pane.providerLabel}</span> : null}
          </div>
        </div>
        <SquareTerminalIcon className="size-4 text-muted-foreground" />
      </header>
      <ScrollArea className="h-full min-h-0" scrollbarGutter>
        <div className="space-y-3 px-4 py-4">
          {props.pane.messages.length > 0 ? (
            props.pane.messages.map((message) => (
              <article
                key={message.id}
                className={cn(
                  "rounded-xl px-4 py-3",
                  message.role === "assistant"
                    ? "bg-background"
                    : message.role === "user"
                      ? "bg-primary/8"
                      : "border border-dashed border-border bg-muted/45 text-muted-foreground",
                )}
              >
                <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  {message.role}
                  {message.streaming ? " streaming" : ""}
                </div>
                <ChatMarkdown
                  text={message.text}
                  cwd={props.markdownCwd}
                  isStreaming={message.streaming}
                />
              </article>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">Waiting for participant transcript.</p>
          )}
        </div>
      </ScrollArea>
    </section>
  );
}

export function ChannelView(props: { threadId: ThreadId }) {
  const navigate = useNavigate();
  const thread = useThreadById(props.threadId);
  const project = useProjectById(thread?.projectId);
  const allThreads = useStore((state) => state.threads);
  const [splitView, setSplitView] = useState(false);
  const [interventionOpen, setInterventionOpen] = useState(false);
  const [interventionText, setInterventionText] = useState("");

  const childThreads = useMemo(() => {
    const childThreadIds = new Set(thread?.childThreadIds ?? []);
    return allThreads.filter((candidate) => childThreadIds.has(candidate.id));
  }, [allThreads, thread?.childThreadIds]);

  const channelQuery = useThreadChannel({
    threadId: thread?.id ?? null,
    channelType: "deliberation",
  });
  const channel = channelQuery.data ?? null;
  const messagesQuery = useChannelMessages(channel?.id ?? null);
  const storedMessages = useChannelStore(
    (state) => (channel ? state.messagesByChannelId[channel.id] : undefined) ?? [],
  );
  const deliberationState = useChannelStore(
    (state) => (channel ? state.deliberationStateByChannelId[channel.id] : null) ?? null,
  );
  const phaseRunId =
    typeof channel?.phaseRunId === "string" && channel.phaseRunId.length > 0
      ? PhaseRunId.makeUnsafe(channel.phaseRunId)
      : null;
  const phaseRunQuery = useQuery(
    queryOptions({
      queryKey: ["channels", "phase-run", phaseRunId] as const,
      queryFn: async () => {
        if (!phaseRunId) {
          return null;
        }
        return (await getWsRpcClient().phaseRun.get({ phaseRunId })).phaseRun;
      },
      enabled: phaseRunId !== null,
      staleTime: 5_000,
      placeholderData: (previous) => previous ?? null,
    }),
  );
  const maxTurns = phaseRunQuery.data?.deliberationState?.maxTurns ?? null;

  const viewModel = useMemo(
    () =>
      buildChannelViewModel({
        channel,
        messages: storedMessages,
        deliberationState,
        thread,
        childThreads,
      }),
    [channel, childThreads, deliberationState, storedMessages, thread],
  );

  const interveneMutation = useMutation(
    channelInterveneMutationOptions({
      channelId: channel?.id ?? null,
    }),
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (shouldToggleChannelSplitView(event)) {
        event.preventDefault();
        event.stopPropagation();
        setSplitView((current) => !current);
        return;
      }

      if (shouldFocusChannelIntervention(event)) {
        event.preventDefault();
        event.stopPropagation();
        setInterventionOpen(true);
        requestAnimationFrame(() => {
          document.getElementById("channel-view-intervention-input")?.focus();
        });
        return;
      }

      if (event.key === "Escape" && interventionOpen) {
        event.preventDefault();
        event.stopPropagation();
        setInterventionOpen(false);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [interventionOpen]);

  const openThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
    });
  };

  const submitIntervention = async () => {
    const content = interventionText.trim();
    if (!content) {
      return;
    }

    await interveneMutation.mutateAsync(content);
    setInterventionText("");
    setInterventionOpen(false);
  };

  const concludeChannel = async () => {
    if (!channel) {
      return;
    }

    const api = readNativeApi();
    if (!api) {
      return;
    }

    await api.orchestration.dispatchCommand({
      type: "channel.conclude",
      commandId: newCommandId(),
      channelId: channel.id,
      createdAt: new Date().toISOString(),
    } as unknown as Parameters<typeof api.orchestration.dispatchCommand>[0]);
  };

  if (!thread || !isChannelContainerThread(thread)) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
        Channel view is only available for deliberation container sessions.
      </div>
    );
  }

  const loading = channelQuery.isLoading || (channel !== null && messagesQuery.isLoading);
  const error =
    channelQuery.error instanceof Error
      ? channelQuery.error
      : messagesQuery.error instanceof Error
        ? messagesQuery.error
        : phaseRunQuery.error instanceof Error
          ? phaseRunQuery.error
          : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="border-b border-border/70 bg-card/70 px-4 py-3 sm:px-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <SidebarTrigger className="-ml-1 mt-0.5" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-base font-semibold text-foreground">
                  {viewModel.headline}
                </h1>
                {channel ? (
                  <span className={statusBadgeVariants({ status: channel.status })}>
                    {channel.status}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {thread.title}
                {" · "}
                {formatTurnCounter(viewModel.turnCount, maxTurns)}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant={splitView ? "secondary" : "outline"}
              size="sm"
              onClick={() => setSplitView((current) => !current)}
            >
              <ArrowRightLeftIcon className="size-4" />
              Split View
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {viewModel.participants.map((participant) =>
            participant.threadId ? (
              <button
                key={participant.id}
                type="button"
                className={participantBadgeVariants({ tone: participant.tone })}
                onClick={() => openThread(participant.threadId!)}
              >
                <span>{participant.label}</span>
                {participant.providerLabel ? (
                  <span className="text-[11px] uppercase tracking-[0.08em] opacity-80">
                    {participant.providerLabel}
                  </span>
                ) : null}
              </button>
            ) : (
              <span
                key={participant.id}
                className={participantBadgeVariants({ tone: participant.tone })}
              >
                {participant.label}
              </span>
            ),
          )}
        </div>
      </header>

      <div
        className={cn(
          "grid min-h-0 flex-1 gap-4 p-4 sm:p-5",
          splitView && viewModel.transcriptPanes.length === 2
            ? "grid-cols-1 xl:grid-cols-[minmax(18rem,1fr)_minmax(0,1.4fr)_minmax(18rem,1fr)]"
            : "grid-cols-1",
        )}
      >
        {splitView && viewModel.transcriptPanes[0] ? (
          <TranscriptPane
            pane={viewModel.transcriptPanes[0]}
            markdownCwd={project?.cwd}
            onOpenThread={openThread}
          />
        ) : null}

        <section className="flex min-h-0 flex-col rounded-2xl border border-border/70 bg-card/75">
          <header className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">Deliberation channel</p>
              <p className="mt-1 text-xs uppercase tracking-[0.08em] text-muted-foreground">
                Live participant exchange
              </p>
            </div>
            <MessagesSquareIcon className="size-4 text-muted-foreground" />
          </header>

          <ScrollArea className="min-h-0 flex-1" scrollbarGutter scrollFade>
            <div className="space-y-3 px-4 py-4">
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading deliberation...</p>
              ) : error ? (
                <div className="rounded-2xl border border-rose-500/20 bg-rose-500/8 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
                  {error.message}
                </div>
              ) : !channel ? (
                <p className="text-sm text-muted-foreground">
                  No deliberation channel is available for this session yet.
                </p>
              ) : viewModel.messages.length > 0 ? (
                viewModel.messages.map((message) => (
                  <article key={message.id} className={messageCardVariants({ tone: message.tone })}>
                    <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      {message.threadId ? (
                        <button
                          type="button"
                          className="truncate text-left transition-colors hover:text-primary"
                          onClick={() => openThread(message.threadId!)}
                        >
                          {message.speakerLabel}
                        </button>
                      ) : (
                        <span>{message.speakerLabel}</span>
                      )}
                      {message.roleLabel ? <span>{message.roleLabel}</span> : null}
                    </div>
                    <ChatMarkdown text={message.content} cwd={project?.cwd} />
                  </article>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">No channel messages yet.</p>
              )}
            </div>
          </ScrollArea>

          <div className="border-t border-border/70 px-4 py-4">
            {interventionOpen ? (
              <div className="space-y-3">
                <Textarea
                  id="channel-view-intervention-input"
                  value={interventionText}
                  onChange={(event) => setInterventionText(event.target.value)}
                  placeholder="Intervene in the deliberation..."
                  aria-label="Intervene in deliberation"
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    Shortcut: <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono">d</kbd>{" "}
                    toggles split view,{" "}
                    <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono">c</kbd> focuses this
                    input.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setInterventionOpen(false);
                        setInterventionText("");
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void submitIntervention()}
                      disabled={interveneMutation.isPending || interventionText.trim().length === 0}
                    >
                      <SendHorizonalIcon className="size-4" />
                      Send
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <AlertCircleIcon className="size-4" />
                  Post guidance into the shared channel or end the deliberation early.
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setInterventionOpen(true)}>
                    Intervene
                  </Button>
                  <Button
                    variant="destructive-outline"
                    size="sm"
                    onClick={() => void concludeChannel()}
                    disabled={channel?.status !== "open"}
                  >
                    <StopCircleIcon className="size-4" />
                    End deliberation
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>

        {splitView && viewModel.transcriptPanes[1] ? (
          <TranscriptPane
            pane={viewModel.transcriptPanes[1]}
            markdownCwd={project?.cwd}
            onOpenThread={openThread}
          />
        ) : null}
      </div>
    </div>
  );
}

export default ChannelView;
