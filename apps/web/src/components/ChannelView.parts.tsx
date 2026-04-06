import { cva } from "class-variance-authority";
import { SquareTerminalIcon } from "lucide-react";
import type { ThreadId } from "@forgetools/contracts";
import { cn } from "../lib/utils";
import ChatMarkdown from "./ChatMarkdown";
import type { buildChannelViewModel } from "./ChannelView.logic";
import { ScrollArea } from "./ui/scroll-area";

export const statusBadgeVariants = cva(
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

export const participantBadgeVariants = cva(
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

export const messageCardVariants = cva("rounded-2xl border px-4 py-3 shadow-xs", {
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

export function formatChannelTurnCounter(turnCount: number, maxTurns: number | null): string {
  return maxTurns === null ? `Turn ${turnCount}` : `Turn ${turnCount}/${maxTurns}`;
}

export function ChannelTranscriptPane(props: {
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
