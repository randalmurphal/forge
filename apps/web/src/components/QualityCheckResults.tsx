import { CheckCircleIcon, ChevronDownIcon, XCircleIcon } from "lucide-react";
import type { QualityCheckResult } from "@forgetools/contracts";
import { buildToneSurfaceStyle } from "../lib/appearance";
import { cn } from "../lib/utils";

function qualityCheckColor(passed: boolean): string {
  return passed ? "var(--success)" : "var(--destructive)";
}

export function QualityCheckResults(props: {
  results: readonly QualityCheckResult[];
  title?: string;
  className?: string;
}) {
  if (props.results.length === 0) {
    return null;
  }

  return (
    <section
      className={cn("rounded-2xl border border-border/70 bg-card/65", props.className)}
      aria-live="polite"
    >
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
              className="rounded-xl border bg-background/65"
              style={buildToneSurfaceStyle(qualityCheckColor(result.passed), {
                borderPercent: 20,
                backgroundPercent: 6,
                textColor: "var(--foreground)",
              })}
              open={!result.passed}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
                <span className="inline-flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
                  <Icon
                    className="size-4 shrink-0"
                    style={{ color: qualityCheckColor(result.passed) }}
                  />
                  <span className="truncate">{result.check}</span>
                </span>

                <span className="inline-flex items-center gap-2">
                  <span
                    className="text-xs font-medium uppercase tracking-[0.08em]"
                    style={{ color: qualityCheckColor(result.passed) }}
                  >
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
