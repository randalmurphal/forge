import { MessagesSquareIcon } from "lucide-react";
import { cn } from "../lib/utils";
import ChatMarkdown from "./ChatMarkdown";
import type {
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
