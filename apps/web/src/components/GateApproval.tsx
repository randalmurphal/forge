import { useMutation } from "@tanstack/react-query";
import { cva } from "class-variance-authority";
import { AlertCircleIcon, CheckCircle2Icon, ShieldAlertIcon, XCircleIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { PhaseRunId, QualityCheckResult, ThreadId } from "@forgetools/contracts";
import { cn } from "../lib/utils";
import { getWsRpcClient } from "../wsRpcClient";
import ChatMarkdown from "./ChatMarkdown";
import { QualityCheckResults } from "./QualityCheckResults";
import {
  approveGate,
  correctGate,
  rejectGate,
  resolveGateApprovalShortcut,
} from "./GateApproval.logic";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

const gateStatusBadgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.08em]",
  {
    variants: {
      tone: {
        waiting: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        rejected: "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300",
      },
    },
  },
);

export function GateApproval(props: {
  threadId: ThreadId;
  phaseRunId: PhaseRunId;
  phaseName: string;
  summaryMarkdown: string | null;
  qualityCheckResults: readonly QualityCheckResult[];
  unresolvedItems?: readonly string[];
  changesSummary?: readonly string[];
  markdownCwd?: string | undefined;
}) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const rpcClient = getWsRpcClient();
  const trimmedDraft = draft.trim();

  const approveMutation = useMutation({
    mutationFn: () =>
      approveGate({
        client: rpcClient,
        threadId: props.threadId,
        phaseRunId: props.phaseRunId,
      }),
  });

  const rejectMutation = useMutation({
    mutationFn: () =>
      rejectGate({
        client: rpcClient,
        threadId: props.threadId,
        phaseRunId: props.phaseRunId,
        reason: draft,
      }),
    onSuccess: () => setDraft(""),
  });

  const correctMutation = useMutation({
    mutationFn: () =>
      correctGate({
        client: rpcClient,
        threadId: props.threadId,
        phaseRunId: props.phaseRunId,
        correction: draft,
      }),
    onSuccess: () => setDraft(""),
  });

  const isSubmitting =
    approveMutation.isPending || rejectMutation.isPending || correctMutation.isPending;
  const currentError =
    approveMutation.error instanceof Error
      ? approveMutation.error
      : rejectMutation.error instanceof Error
        ? rejectMutation.error
        : correctMutation.error instanceof Error
          ? correctMutation.error
          : null;

  const handleWindowKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const action = resolveGateApprovalShortcut({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      targetTagName: event.target instanceof HTMLElement ? event.target.tagName : null,
      isContentEditable:
        event.target instanceof HTMLElement ? event.target.isContentEditable : false,
    });

    if (action === "approve" && !isSubmitting) {
      event.preventDefault();
      void approveMutation.mutateAsync();
      return;
    }

    if (action === "correct" && !isSubmitting) {
      event.preventDefault();
      if (trimmedDraft.length === 0) {
        textareaRef.current?.focus();
        return;
      }
      void correctMutation.mutateAsync();
      return;
    }

    if (action === "reject" && !isSubmitting) {
      event.preventDefault();
      if (trimmedDraft.length === 0) {
        textareaRef.current?.focus();
        return;
      }
      void rejectMutation.mutateAsync();
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, []);

  return (
    <section className="rounded-2xl border border-amber-500/20 bg-card/75 shadow-sm">
      <header className="border-b border-border/70 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={gateStatusBadgeVariants({ tone: "waiting" })}>
            <ShieldAlertIcon className="size-3.5" />
            Human Review Required
          </span>
          <span className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
            Phase {props.phaseName}
          </span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">Waiting for approval.</p>
      </header>

      <div className="space-y-4 px-4 py-4 sm:px-5">
        {props.summaryMarkdown ? (
          <section className="rounded-xl border border-border/70 bg-background/60 px-4 py-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Summary
            </p>
            <ChatMarkdown text={props.summaryMarkdown} cwd={props.markdownCwd} />
          </section>
        ) : null}

        <QualityCheckResults results={props.qualityCheckResults} />

        {props.unresolvedItems && props.unresolvedItems.length > 0 ? (
          <section className="rounded-xl border border-border/70 bg-background/60 px-4 py-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Unresolved
            </p>
            <ul className="space-y-2 text-sm text-foreground">
              {props.unresolvedItems.map((item) => (
                <li key={item} className="flex gap-2">
                  <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-amber-500" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {props.changesSummary && props.changesSummary.length > 0 ? (
          <section className="rounded-xl border border-border/70 bg-background/60 px-4 py-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Changes
            </p>
            <ul className="space-y-2 text-sm text-foreground">
              {props.changesSummary.map((item) => (
                <li key={item} className="flex gap-2">
                  <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="space-y-3 rounded-xl border border-border/70 bg-background/60 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Correction
            </p>
            <p className="text-xs text-muted-foreground">
              Shortcuts: `a` approve, `c` correct, `r` reject
            </p>
          </div>

          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Add a correction for retrying or a reason for failing this gate."
            className="min-h-28 resize-y"
            aria-label="Gate correction or rejection reason"
          />

          {currentError ? (
            <div
              className={cn(
                "rounded-lg border px-3 py-2 text-sm",
                gateStatusBadgeVariants({ tone: "rejected" }),
              )}
              role="alert"
            >
              <XCircleIcon className="size-4" />
              <span>{currentError.message}</span>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => void approveMutation.mutateAsync()}
              disabled={isSubmitting}
              aria-keyshortcuts="a"
            >
              Approve & Continue
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void correctMutation.mutateAsync()}
              disabled={isSubmitting || trimmedDraft.length === 0}
              aria-keyshortcuts="c"
            >
              Correct & Retry
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void rejectMutation.mutateAsync()}
              disabled={isSubmitting || trimmedDraft.length === 0}
              aria-keyshortcuts="r"
            >
              Reject
            </Button>
          </div>
        </section>
      </div>
    </section>
  );
}
