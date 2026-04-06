import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertCircleIcon,
  ArrowRightLeftIcon,
  MessagesSquareIcon,
  SendHorizonalIcon,
  StopCircleIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PhaseRunId, type ThreadId } from "@forgetools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useProjectById, useThreadById, useThreadsByIds } from "../storeSelectors";
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
  canToggleChannelSplitView,
  canInterveneInChannel,
  isChannelContainerThread,
  shouldFocusChannelIntervention,
  shouldToggleChannelSplitView,
} from "./ChannelView.logic";
import {
  ChannelTranscriptPane,
  formatChannelTurnCounter,
  messageCardVariants,
  participantBadgeVariants,
  statusBadgeVariants,
} from "./ChannelView.parts";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { SidebarTrigger } from "./ui/sidebar";
import { Textarea } from "./ui/textarea";

export function ChannelView(props: { threadId: ThreadId }) {
  const navigate = useNavigate();
  const thread = useThreadById(props.threadId);
  const project = useProjectById(thread?.projectId);
  const childThreads = useThreadsByIds(thread?.childThreadIds);
  const [splitView, setSplitView] = useState(false);
  const [interventionOpen, setInterventionOpen] = useState(false);
  const [interventionText, setInterventionText] = useState("");
  const interventionTriggerRef = useRef<HTMLButtonElement | null>(null);

  const closeIntervention = (restoreFocus: boolean) => {
    setInterventionOpen(false);
    if (!restoreFocus) {
      return;
    }

    requestAnimationFrame(() => {
      interventionTriggerRef.current?.focus();
    });
  };

  const channelQuery = useThreadChannel({
    threadId: thread?.id ?? null,
    channelType: "deliberation",
  });
  const channel = channelQuery.data ?? null;
  const canIntervene = canInterveneInChannel(channel);
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
  const canToggleSplitView = canToggleChannelSplitView(viewModel.transcriptPanes);

  const interveneMutation = useMutation(
    channelInterveneMutationOptions({
      channelId: channel?.id ?? null,
    }),
  );

  useEffect(() => {
    if (canIntervene || !interventionOpen) {
      return;
    }

    closeIntervention(false);
    setInterventionText("");
  }, [canIntervene, interventionOpen]);

  useEffect(() => {
    if (!canToggleSplitView && splitView) {
      setSplitView(false);
    }
  }, [canToggleSplitView, splitView]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (shouldToggleChannelSplitView(event)) {
        if (!canToggleSplitView) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setSplitView((current) => !current);
        return;
      }

      if (shouldFocusChannelIntervention(event)) {
        if (!canIntervene) {
          return;
        }
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
        closeIntervention(true);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [canIntervene, canToggleSplitView, interventionOpen]);

  const openThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
    });
  };

  const submitIntervention = async () => {
    if (!canIntervene) {
      return;
    }

    const content = interventionText.trim();
    if (!content) {
      return;
    }

    await interveneMutation.mutateAsync(content);
    setInterventionText("");
    closeIntervention(true);
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
                <span aria-live="polite">
                  {formatChannelTurnCounter(viewModel.turnCount, maxTurns)}
                </span>
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant={splitView ? "secondary" : "outline"}
              size="sm"
              onClick={() => setSplitView((current) => !current)}
              aria-pressed={splitView}
              aria-keyshortcuts="d"
              disabled={!canToggleSplitView}
              title={
                canToggleSplitView
                  ? undefined
                  : "Split view becomes available once both participant transcripts are ready."
              }
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
          splitView && canToggleSplitView
            ? "grid-cols-1 xl:grid-cols-[minmax(18rem,1fr)_minmax(0,1.4fr)_minmax(18rem,1fr)]"
            : "grid-cols-1",
        )}
      >
        {splitView && viewModel.transcriptPanes[0] ? (
          <ChannelTranscriptPane
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
            <div
              className="space-y-3 px-4 py-4"
              role="log"
              aria-live="polite"
              aria-relevant="additions text"
              aria-label="Deliberation channel messages"
            >
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
            {interventionOpen && canIntervene ? (
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
                        closeIntervention(true);
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
                  <Button
                    ref={interventionTriggerRef}
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (!canIntervene) {
                        return;
                      }
                      setInterventionOpen(true);
                    }}
                    aria-keyshortcuts="c"
                    disabled={!canIntervene}
                  >
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
          <ChannelTranscriptPane
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
