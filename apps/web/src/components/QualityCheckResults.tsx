import { cva } from "class-variance-authority";
import { CheckCircleIcon, ChevronDownIcon, XCircleIcon } from "lucide-react";
import type { QualityCheckResult } from "@forgetools/contracts";
import { cn } from "../lib/utils";

const qualityCheckRowVariants = cva("rounded-xl border bg-background/65", {
  variants: {
    passed: {
      true: "border-emerald-500/20",
      false: "border-rose-500/20",
    },
  },
});

const qualityCheckStatusVariants = cva("text-xs font-medium uppercase tracking-[0.08em]", {
  variants: {
    passed: {
      true: "text-emerald-600 dark:text-emerald-300",
      false: "text-rose-600 dark:text-rose-300",
    },
  },
});

export function QualityCheckResults(props: {
  results: readonly QualityCheckResult[];
  title?: string;
  className?: string;
}) {
  if (props.results.length === 0) {
    return null;
  }

  return (
    <section className={cn("rounded-2xl border border-border/70 bg-card/65", props.className)}>
      <header className="border-b border-border/70 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          {props.title ?? "Quality Checks"}
        </p>
      </header>

      <div className="space-y-3 px-4 py-4">
        {props.results.map((result) => {
          const Icon = result.passed ? CheckCircleIcon : XCircleIcon;

          return (
            <details
              key={result.check}
              className={qualityCheckRowVariants({ passed: result.passed })}
              open={!result.passed}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
                <span className="inline-flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
                  <Icon
                    className={cn(
                      "size-4 shrink-0",
                      result.passed ? "text-emerald-500" : "text-rose-500",
                    )}
                  />
                  <span className="truncate">{result.check}</span>
                </span>

                <span className="inline-flex items-center gap-2">
                  <span className={qualityCheckStatusVariants({ passed: result.passed })}>
                    {result.passed ? "passed" : "failed"}
                  </span>
                  <ChevronDownIcon className="size-4 text-muted-foreground" />
                </span>
              </summary>

              {result.output ? (
                <pre className="overflow-auto border-t border-border/70 px-4 py-3 text-xs whitespace-pre-wrap text-foreground/85">
                  {result.output}
                </pre>
              ) : null}
            </details>
          );
        })}
      </div>
    </section>
  );
}
