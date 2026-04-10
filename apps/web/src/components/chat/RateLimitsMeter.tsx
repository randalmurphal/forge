import { useMemo } from "react";
import { cn } from "~/lib/utils";
import { useRateLimits } from "~/rpc/serverState";
import {
  deriveRateLimitDisplay,
  formatResetTime,
  type RateLimitDisplayEntry,
} from "~/lib/rateLimits";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function strokeColorForPercent(percent: number): string {
  if (percent >= 95) return "var(--color-destructive)";
  if (percent >= 80) return "var(--color-warning)";
  return "var(--color-muted-foreground)";
}

function WindowRows({ entry }: { entry: RateLimitDisplayEntry }) {
  return (
    <div className="space-y-0.5">
      {entry.primaryPercent !== null ? (
        <div className="flex items-baseline justify-between gap-3 whitespace-nowrap text-xs">
          <span className="text-muted-foreground">5-hour</span>
          <span className="font-medium text-foreground">{Math.round(entry.primaryPercent)}%</span>
          {entry.primaryResetsAt ? (
            <span className="text-muted-foreground">
              resets in {formatResetTime(entry.primaryResetsAt)}
            </span>
          ) : null}
        </div>
      ) : null}
      {entry.secondaryPercent !== null ? (
        <div className="flex items-baseline justify-between gap-3 whitespace-nowrap text-xs">
          <span className="text-muted-foreground">Weekly</span>
          <span className="font-medium text-foreground">{Math.round(entry.secondaryPercent)}%</span>
          {entry.secondaryResetsAt ? (
            <span className="text-muted-foreground">
              resets in {formatResetTime(entry.secondaryResetsAt)}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function RateLimitsMeter() {
  const rateLimits = useRateLimits();

  const display = useMemo(
    () => (rateLimits && rateLimits.limits.length > 0 ? deriveRateLimitDisplay(rateLimits) : null),
    [rateLimits],
  );

  if (!display || display.maxPercent <= 0) return null;

  const mainEntry = display.entries.find((e) => e.limitName === null) ?? display.entries[0]!;
  const subLimitEntries = display.entries.filter((e) => e !== mainEntry && e.limitName !== null);

  const normalizedPercent = Math.max(0, Math.min(100, display.maxPercent));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercent / 100) * circumference;
  const strokeColor = strokeColorForPercent(normalizedPercent);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className="group inline-flex items-center justify-center rounded-full transition-opacity hover:opacity-85"
            aria-label={`Usage limits ${Math.round(normalizedPercent)}%`}
          >
            <span className="relative flex h-6 w-6 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 h-full w-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted) 70%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
              <span
                className={cn(
                  "relative flex h-[15px] w-[15px] items-center justify-center rounded-full bg-background text-[8px] font-medium",
                  "text-muted-foreground",
                )}
              >
                {Math.round(normalizedPercent)}
              </span>
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-max max-w-none px-3 py-2">
        <div className="space-y-1.5 leading-tight">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Usage limits
          </div>
          <WindowRows entry={mainEntry} />
          {subLimitEntries.length > 0 ? (
            <>
              <div className="my-1.5 h-px bg-border" />
              {subLimitEntries.map((entry) => (
                <div key={entry.limitId} className="space-y-0.5">
                  <div className="text-[10px] font-medium text-muted-foreground">
                    {entry.limitName}
                  </div>
                  <WindowRows entry={entry} />
                </div>
              ))}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
