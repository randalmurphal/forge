import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import { cva } from "class-variance-authority";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  MessagesSquareIcon,
  XCircleIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ThreadId, WorkflowPhase } from "@forgetools/contracts";
import { useStore } from "../store";
import { useProjectById, useThreadById } from "../storeSelectors";
import { useWorkflow } from "../stores/workflowStore";
import { getWsRpcClient } from "../wsRpcClient";
import { cn } from "../lib/utils";
import ChatMarkdown from "./ChatMarkdown";
import { SidebarTrigger } from "./ui/sidebar";
import {
  buildWorkflowTimeline,
  type WorkflowTimelineChildSession,
  type WorkflowTimelinePhaseOutputRecord,
} from "./WorkflowTimeline.logic";

const workflowTimelineQueryKeys = {
  phaseRuns: (threadId: ThreadId) => ["workflow-timeline", "phase-runs", threadId] as const,
  phaseOutput: (phaseRunId: string, outputKeys: readonly string[]) =>
    ["workflow-timeline", "phase-output", phaseRunId, outputKeys.join("|")] as const,
};

const phaseStatusBadgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-[0.08em] uppercase",
  {
    variants: {
      status: {
        completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        failed: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
        pending: "border-zinc-500/20 bg-zinc-500/8 text-zinc-700 dark:text-zinc-300",
        running: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
        skipped: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      },
    },
  },
);

function workflowPhaseRunsQueryOptions(threadId: ThreadId) {
  return queryOptions({
    queryKey: workflowTimelineQueryKeys.phaseRuns(threadId),
    queryFn: async () => (await getWsRpcClient().phaseRun.list({ threadId })).phaseRuns,
    staleTime: 5_000,
  });
}

function isMissingPhaseOutputError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Failed to load phase output");
}

function resolvePhaseOutputCandidateKeys(
  phase: WorkflowPhase | null,
  phaseType: WorkflowPhase["type"],
): string[] {
  if (phaseType === "multi-agent") {
    return ["channel", "output"];
  }

  const outputType = phase?.agent?.output?.type;
  if (outputType === "schema") {
    return ["summary", "output"];
  }
  if (outputType === "channel") {
    return ["channel", "output"];
  }

  return ["output", "summary"];
}

function formatRoleLabel(role: string | null | undefined): string | null {
  if (!role) {
    return null;
  }

  return role
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function formatPhaseTypeLabel(phaseType: string): string {
  return phaseType.replace(/-/g, " ");
}

function statusIconForPhase(status: string) {
  switch (status) {
    case "completed":
      return CheckCircle2Icon;
    case "failed":
      return XCircleIcon;
    case "running":
      return LoaderCircleIcon;
    case "skipped":
      return CircleAlertIcon;
    default:
      return CircleDashedIcon;
  }
}

function PhaseTranscriptPanel(props: {
  childSessions: readonly WorkflowTimelineChildSession[];
  markdownCwd: string | undefined;
  emptyLabel: string;
}) {
  if (props.childSessions.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border/70 bg-background/60 px-4 py-3 text-sm text-muted-foreground">
        {props.emptyLabel}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {props.childSessions.map((childSession) => {
        const roleLabel = formatRoleLabel(childSession.role);
        const providerLabel =
          childSession.provider === "claudeAgent"
            ? "Claude"
            : childSession.provider === "codex"
              ? "Codex"
              : null;

        return (
          <section
            key={childSession.threadId}
            className="rounded-xl border border-border/70 bg-background/70"
          >
            <header className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{childSession.title}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground uppercase tracking-[0.08em]">
                  {roleLabel ? <span>{roleLabel}</span> : null}
                  {providerLabel ? <span>{providerLabel}</span> : null}
                </div>
              </div>
            </header>

            <div className="space-y-3 px-4 py-4">
              {childSession.messages.length > 0 ? (
                childSession.messages.map((message) => (
                  <article
                    key={message.id}
                    className={cn(
                      "rounded-xl px-4 py-3",
                      message.role === "assistant"
                        ? "bg-card text-card-foreground"
                        : message.role === "system"
                          ? "border border-dashed border-border bg-muted/40 text-muted-foreground"
                          : "bg-primary/8 text-foreground",
                    )}
                  >
                    <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      {message.role}
                      {message.streaming ? " • streaming" : ""}
                    </div>
                    <ChatMarkdown
                      text={message.text}
                      cwd={props.markdownCwd}
                      isStreaming={message.streaming}
                    />
                  </article>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">Waiting for transcript output.</p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function PhaseOutputBody(props: {
  output: ReturnType<typeof buildWorkflowTimeline>[number]["output"];
  markdownCwd: string | undefined;
}) {
  switch (props.output.kind) {
    case "schema":
      return (
        <div className="space-y-3">
          <ChatMarkdown text={props.output.summaryMarkdown} cwd={props.markdownCwd} />
          {props.output.structuredData ? (
            <details className="overflow-hidden rounded-xl border border-border/70 bg-background/60">
              <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-muted-foreground">
                Structured output
              </summary>
              <pre className="overflow-auto border-t border-border/70 px-4 py-3 text-xs text-foreground/85">
                {JSON.stringify(props.output.structuredData, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>
      );
    case "channel":
      return (
        <div className="space-y-3">
          {props.output.messages.map((message) => (
            <article
              key={`${message.speaker}:${message.content}`}
              className="rounded-xl bg-card px-4 py-3"
            >
              <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                <MessagesSquareIcon className="size-3.5" />
                <span>{message.speaker}</span>
              </div>
              <ChatMarkdown text={message.content} cwd={props.markdownCwd} />
            </article>
          ))}
        </div>
      );
    case "conversation":
      return <ChatMarkdown text={props.output.markdown} cwd={props.markdownCwd} />;
    case "none":
      return <p className="text-sm text-muted-foreground">No persisted output yet.</p>;
  }
}

function PhaseQualityChecks(props: {
  checks: readonly { check: string; passed: boolean; output?: string | undefined }[];
}) {
  if (props.checks.length === 0) {
    return null;
  }

  return (
    <section className="rounded-2xl border border-border/70 bg-card/65">
      <header className="border-b border-border/70 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          Quality Checks
        </p>
      </header>
      <div className="space-y-3 px-4 py-4">
        {props.checks.map((check) => {
          const Icon = check.passed ? CheckCircle2Icon : XCircleIcon;
          const iconClassName = check.passed ? "text-emerald-500" : "text-rose-500";
          return (
            <details
              key={check.check}
              className="rounded-xl border border-border/70 bg-background/65"
              open={!check.passed}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
                <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                  <Icon className={cn("size-4", iconClassName)} />
                  {check.check}
                </span>
                <span
                  className={cn("text-xs font-medium uppercase tracking-[0.08em]", iconClassName)}
                >
                  {check.passed ? "passed" : "failed"}
                </span>
              </summary>
              {check.output ? (
                <pre className="overflow-auto border-t border-border/70 px-4 py-3 text-xs text-foreground/85 whitespace-pre-wrap">
                  {check.output}
                </pre>
              ) : null}
            </details>
          );
        })}
      </div>
    </section>
  );
}

export function WorkflowTimeline({ threadId }: { threadId: ThreadId }) {
  const [expandedPhaseRunIds, setExpandedPhaseRunIds] = useState<Set<string>>(() => new Set());
  const thread = useThreadById(threadId);
  const project = useProjectById(thread?.projectId ?? null);
  const childThreads = useStore((state) =>
    state.threads.filter((candidate) => candidate.parentThreadId === threadId),
  );
  const workflowQuery = useWorkflow(thread?.workflowId ?? null);
  const phaseRunsQuery = useQuery({
    ...workflowPhaseRunsQueryOptions(threadId),
    enabled: thread?.workflowId != null,
  });

  const phasesById = useMemo(
    () => new Map((workflowQuery.data?.phases ?? []).map((phase) => [phase.id, phase] as const)),
    [workflowQuery.data],
  );

  const phaseOutputQueries = useQueries({
    queries: (phaseRunsQuery.data ?? []).map((phaseRun) => {
      const outputKeys = resolvePhaseOutputCandidateKeys(
        phasesById.get(phaseRun.phaseId) ?? null,
        phaseRun.phaseType,
      );

      return queryOptions({
        queryKey: workflowTimelineQueryKeys.phaseOutput(phaseRun.phaseRunId, outputKeys),
        queryFn: async () => {
          for (const outputKey of outputKeys) {
            try {
              return (
                await getWsRpcClient().phaseOutput.get({
                  phaseRunId: phaseRun.phaseRunId,
                  outputKey,
                })
              ).output;
            } catch (error) {
              if (isMissingPhaseOutputError(error)) {
                continue;
              }
              throw error;
            }
          }

          return null;
        },
        staleTime: 5_000,
      });
    }),
  });

  const childSessionsByPhaseRunId = useMemo(() => {
    const mapped: Record<string, WorkflowTimelineChildSession[]> = {};

    for (const childThread of childThreads) {
      if (!childThread.phaseRunId) {
        continue;
      }

      const phaseRunId = childThread.phaseRunId;
      const childSessionsForPhaseRun = mapped[phaseRunId] ?? [];
      childSessionsForPhaseRun.push({
        threadId: childThread.id,
        title: childThread.title,
        role: childThread.role ?? null,
        provider: childThread.session?.provider ?? null,
        status: childThread.session?.status ?? null,
        updatedAt: childThread.updatedAt,
        messages: childThread.messages,
      });
      mapped[phaseRunId] = childSessionsForPhaseRun;
    }

    return mapped;
  }, [childThreads]);

  const phaseOutputsByPhaseRunId = useMemo(() => {
    const mapped: Record<string, WorkflowTimelinePhaseOutputRecord | null> = {};
    const phaseRuns = phaseRunsQuery.data ?? [];

    phaseRuns.forEach((phaseRun, index) => {
      const output = phaseOutputQueries[index]?.data;
      mapped[phaseRun.phaseRunId] = output
        ? {
            outputKey: output.outputKey,
            content: output.content,
            sourceType: output.sourceType,
          }
        : null;
    });

    return mapped;
  }, [phaseOutputQueries, phaseRunsQuery.data]);

  const timeline = useMemo(
    () =>
      buildWorkflowTimeline({
        workflow: workflowQuery.data ?? null,
        phaseRuns: phaseRunsQuery.data ?? [],
        phaseOutputsByPhaseRunId,
        childSessionsByPhaseRunId,
      }),
    [childSessionsByPhaseRunId, phaseOutputsByPhaseRunId, phaseRunsQuery.data, workflowQuery.data],
  );

  const phaseOutputError = phaseOutputQueries.find((query) => query.error instanceof Error)?.error;
  const phaseOutputsLoading = phaseOutputQueries.some((query) => query.isPending);
  const isLoading =
    (thread?.workflowId != null && workflowQuery.isLoading) ||
    phaseRunsQuery.isLoading ||
    phaseOutputsLoading;
  const queryError =
    workflowQuery.error instanceof Error
      ? workflowQuery.error
      : phaseRunsQuery.error instanceof Error
        ? phaseRunsQuery.error
        : phaseOutputError instanceof Error
          ? phaseOutputError
          : null;

  if (!thread) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Workflow thread unavailable.
      </div>
    );
  }

  if (queryError) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-lg rounded-2xl border border-rose-500/20 bg-rose-500/8 px-5 py-4 text-sm text-rose-700 dark:text-rose-300">
          {queryError.message}
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-3 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" />
        Loading workflow timeline...
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="border-b border-border/70 px-4 py-3 sm:px-5">
        <div className="flex items-start gap-3">
          <SidebarTrigger className="mt-0.5 size-8 shrink-0 md:hidden" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {workflowQuery.data?.name ?? "Workflow"}
            </p>
            <h1 className="truncate text-lg font-semibold sm:text-xl">{thread.title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {workflowQuery.data?.description || "Phase outputs and child session activity."}
            </p>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-5 sm:px-5 sm:py-6">
          {timeline.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/70 bg-card/60 px-5 py-8 text-center text-sm text-muted-foreground">
              No phase runs have been recorded for this workflow yet.
            </div>
          ) : (
            timeline.map((phaseItem) => {
              const expanded = phaseItem.isActive || expandedPhaseRunIds.has(phaseItem.phaseRunId);
              const StatusIcon = statusIconForPhase(phaseItem.status);
              const roleLabelCount = phaseItem.childSessions.length;

              return (
                <section key={phaseItem.phaseRunId} className="space-y-4">
                  <article className="overflow-hidden rounded-2xl border border-border/70 bg-card/75 shadow-sm">
                    <button
                      type="button"
                      className="flex w-full items-start justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-accent/35 sm:px-5"
                      onClick={() =>
                        setExpandedPhaseRunIds((current) => {
                          const next = new Set(current);
                          if (next.has(phaseItem.phaseRunId)) {
                            next.delete(phaseItem.phaseRunId);
                          } else {
                            next.add(phaseItem.phaseRunId);
                          }
                          return next;
                        })
                      }
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={phaseStatusBadgeVariants({
                              status: phaseItem.status,
                            })}
                          >
                            <StatusIcon
                              className={cn(
                                "size-3.5",
                                phaseItem.status === "running" ? "animate-spin" : "",
                              )}
                            />
                            {phaseItem.status}
                          </span>
                          <span className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
                            {formatPhaseTypeLabel(phaseItem.phaseType)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            Iteration {phaseItem.iteration}
                          </span>
                        </div>
                        <h2 className="mt-3 text-lg font-semibold">{phaseItem.phaseName}</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {roleLabelCount > 0
                            ? `${roleLabelCount} child ${roleLabelCount === 1 ? "session" : "sessions"} attached`
                            : "No child session transcript attached yet."}
                        </p>
                      </div>
                      <span className="mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/80 text-muted-foreground">
                        {expanded ? (
                          <ChevronDownIcon className="size-4" />
                        ) : (
                          <ChevronRightIcon className="size-4" />
                        )}
                      </span>
                    </button>

                    <div className="border-t border-border/70 px-4 py-4 sm:px-5">
                      <PhaseOutputBody output={phaseItem.output} markdownCwd={project?.cwd} />
                    </div>

                    {expanded ? (
                      <div className="border-t border-border/70 bg-background/35 px-4 py-4 sm:px-5">
                        <PhaseTranscriptPanel
                          childSessions={phaseItem.childSessions}
                          markdownCwd={project?.cwd}
                          emptyLabel={
                            phaseItem.isActive
                              ? "Waiting for the active child session to emit transcript output."
                              : "Transcript unavailable for this phase run."
                          }
                        />
                      </div>
                    ) : null}
                  </article>

                  <PhaseQualityChecks checks={phaseItem.qualityChecks} />
                </section>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
