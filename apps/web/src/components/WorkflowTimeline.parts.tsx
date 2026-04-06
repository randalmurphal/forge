import {
  CheckCircle2Icon,
  CircleAlertIcon,
  LoaderCircleIcon,
  MessagesSquareIcon,
  XCircleIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import ChatMarkdown from "./ChatMarkdown";
import type {
  WorkflowTimelineTransitionState,
  WorkflowTimelineChildSession,
  WorkflowTimelineRenderableOutput,
} from "./WorkflowTimeline.logic";

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

export function WorkflowTimelineTranscriptPanel(props: {
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

export function WorkflowTimelineOutputBody(props: {
  output: WorkflowTimelineRenderableOutput;
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

function transitionIcon(state: WorkflowTimelineTransitionState) {
  switch (state.kind) {
    case "quality-checks":
      return LoaderCircleIcon;
    case "phase-handoff":
      return CheckCircle2Icon;
    case "bootstrap":
      return state.status === "failed"
        ? XCircleIcon
        : state.status === "completed"
          ? CheckCircle2Icon
          : CircleAlertIcon;
    case "waiting-human":
      return CircleAlertIcon;
  }
}

function transitionTitle(state: WorkflowTimelineTransitionState): string {
  switch (state.kind) {
    case "quality-checks":
      return "Running quality checks...";
    case "phase-handoff":
      return `${state.phaseName ?? "Phase"} completed. Starting ${state.nextPhaseName}...`;
    case "bootstrap":
      return state.nextPhaseName
        ? `Setting up ${state.nextPhaseName}...`
        : "Setting up next phase...";
    case "waiting-human":
      return "Waiting for approval";
  }
}

function transitionDescription(state: WorkflowTimelineTransitionState): string {
  switch (state.kind) {
    case "quality-checks":
      return "Live check output appears here as the gate evaluates.";
    case "phase-handoff":
      return "The next child session will open automatically as soon as it spawns.";
    case "bootstrap":
      if (state.status === "failed") {
        return state.error ?? "Bootstrap failed.";
      }
      if (state.status === "completed") {
        return "Bootstrap completed. Waiting for the next child session to start.";
      }
      if (state.status === "skipped") {
        return "Bootstrap was skipped. Waiting for the next child session to start.";
      }
      return "Bootstrap output is streaming in real time.";
    case "waiting-human":
      return "Review the phase output and choose how to proceed.";
  }
}

export function WorkflowTimelineTransitionPanel(props: { state: WorkflowTimelineTransitionState }) {
  const { state } = props;
  const TransitionIcon = transitionIcon(state);

  return (
    <section
      className="overflow-hidden rounded-2xl border border-border/70 bg-card/75 shadow-sm"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-3 border-b border-border/70 px-4 py-4 sm:px-5">
        <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/80 text-muted-foreground">
          <TransitionIcon
            className={cn(
              "size-4",
              state.kind === "quality-checks" ||
                (state.kind === "bootstrap" && state.status === "running")
                ? "animate-spin"
                : "",
            )}
          />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">{transitionTitle(state)}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{transitionDescription(state)}</p>
        </div>
      </div>

      {state.kind === "quality-checks" ? (
        <div className="space-y-3 px-4 py-4 sm:px-5" aria-live="polite">
          {state.checks.length === 0 ? (
            <p className="text-sm text-muted-foreground">Waiting for check output.</p>
          ) : (
            state.checks.map((check) => (
              <article
                key={`${check.checkName}:${check.timestamp}`}
                className="rounded-xl border border-border/70 bg-background/60 px-4 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-foreground">{check.checkName}</p>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-[0.08em]",
                      check.status === "passed"
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        : check.status === "failed"
                          ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                          : "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
                    )}
                  >
                    {check.status}
                  </span>
                </div>
                {check.output ? (
                  <pre className="mt-3 overflow-auto rounded-lg bg-background px-3 py-2 text-xs text-foreground/85">
                    {check.output}
                  </pre>
                ) : null}
              </article>
            ))
          )}
        </div>
      ) : null}

      {state.kind === "bootstrap" ? (
        <div className="px-4 py-4 sm:px-5">
          {state.output.length > 0 ? (
            <pre
              className="overflow-auto rounded-xl bg-background px-4 py-3 text-xs text-foreground/85"
              aria-live="polite"
            >
              {state.output}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">Waiting for bootstrap output.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
