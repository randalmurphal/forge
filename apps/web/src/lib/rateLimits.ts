import type { RateLimitsSnapshot } from "@forgetools/contracts";

// ── Display types ────────────────────────────────────────────────────

export interface RateLimitDisplayEntry {
  readonly limitId: string;
  readonly limitName: string | null;
  readonly primaryPercent: number | null;
  readonly secondaryPercent: number | null;
  readonly primaryResetsAt: number | null;
  readonly secondaryResetsAt: number | null;
}

export interface RateLimitDisplay {
  /** Max 5h usedPercent across all entries */
  readonly primaryPercent: number | null;
  /** Max 7d usedPercent across all entries */
  readonly secondaryPercent: number | null;
  /** Max of primary and secondary — drives the ring indicator */
  readonly maxPercent: number;
  /** Which window is most constrained */
  readonly constrainedWindow: "5h" | "7d";
  /** Reset time for the most-constrained window (epoch seconds) */
  readonly resetsAt: number | null;
  /** All entries for the detailed popover */
  readonly entries: ReadonlyArray<RateLimitDisplayEntry>;
}

// ── Derivation ───────────────────────────────────────────────────────

export function deriveRateLimitDisplay(snapshot: RateLimitsSnapshot): RateLimitDisplay {
  let maxPrimaryPercent: number | null = null;
  let maxPrimaryResetsAt: number | null = null;
  let maxSecondaryPercent: number | null = null;
  let maxSecondaryResetsAt: number | null = null;

  const entries: RateLimitDisplayEntry[] = [];

  for (const entry of snapshot.limits) {
    entries.push({
      limitId: entry.limitId,
      limitName: entry.limitName,
      primaryPercent: entry.primary?.usedPercent ?? null,
      secondaryPercent: entry.secondary?.usedPercent ?? null,
      primaryResetsAt: entry.primary?.resetsAt ?? null,
      secondaryResetsAt: entry.secondary?.resetsAt ?? null,
    });

    if (entry.primary != null) {
      if (maxPrimaryPercent == null || entry.primary.usedPercent > maxPrimaryPercent) {
        maxPrimaryPercent = entry.primary.usedPercent;
        maxPrimaryResetsAt = entry.primary.resetsAt;
      }
    }

    if (entry.secondary != null) {
      if (maxSecondaryPercent == null || entry.secondary.usedPercent > maxSecondaryPercent) {
        maxSecondaryPercent = entry.secondary.usedPercent;
        maxSecondaryResetsAt = entry.secondary.resetsAt;
      }
    }
  }

  const primaryValue = maxPrimaryPercent ?? 0;
  const secondaryValue = maxSecondaryPercent ?? 0;
  const primaryIsConstrained = primaryValue >= secondaryValue;

  return {
    primaryPercent: maxPrimaryPercent,
    secondaryPercent: maxSecondaryPercent,
    maxPercent: Math.max(primaryValue, secondaryValue),
    constrainedWindow: primaryIsConstrained ? "5h" : "7d",
    resetsAt: primaryIsConstrained ? maxPrimaryResetsAt : maxSecondaryResetsAt,
    entries,
  };
}

// ── Formatting ───────────────────────────────────────────────────────

export function formatResetTime(epochSeconds: number): string {
  const remainingMs = epochSeconds * 1000 - Date.now();
  if (remainingMs <= 0) return "now";

  const totalMinutes = Math.floor(remainingMs / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const remainderMinutes = totalMinutes % 60;

  if (totalHours >= 48) {
    const days = Math.floor(totalHours / 24);
    const remainderHours = totalHours % 24;
    return `${days}d ${remainderHours}h`;
  }

  if (totalHours >= 1) {
    return `${totalHours}h ${remainderMinutes}m`;
  }

  if (totalMinutes >= 1) {
    return `${totalMinutes}m`;
  }

  return "<1m";
}
