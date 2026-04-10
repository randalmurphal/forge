import type { RateLimitEntry, RateLimitWindow, RateLimitsSnapshot } from "@forgetools/contracts";

// ── Validation helpers ──────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractWindow(raw: unknown): RateLimitWindow | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const usedPercent = asNumber(obj.usedPercent);
  const windowDurationMins = asNumber(obj.windowDurationMins);
  const resetsAt = asNumber(obj.resetsAt);
  if (usedPercent === null || windowDurationMins === null || resetsAt === null) return null;
  return { usedPercent, windowDurationMins, resetsAt };
}

// ── Codex normalization ─────────────────────────────────────────────────

function extractCodexEntry(raw: unknown): RateLimitEntry | null {
  const obj = asRecord(raw);
  if (!obj) return null;

  const limitId = asString(obj.limitId);
  if (!limitId) return null;

  const limitName = asString(obj.limitName) ?? null;
  const primary = extractWindow(obj.primary);
  const secondary = extractWindow(obj.secondary);

  if (!primary && !secondary) return null;

  return { limitId, limitName, primary, secondary };
}

/**
 * Normalize a raw Codex `account/rateLimits/updated` notification payload
 * into a `RateLimitsSnapshot`.
 */
export function normalizeCodexRateLimits(raw: unknown, now: string): RateLimitsSnapshot | null {
  const root = asRecord(raw);
  if (!root) return null;

  const limits: RateLimitEntry[] = [];

  const byId = asRecord(root.rateLimitsByLimitId);
  if (byId) {
    for (const value of Object.values(byId)) {
      const entry = extractCodexEntry(value);
      if (entry) limits.push(entry);
    }
  } else {
    const single = extractCodexEntry(root.rateLimits);
    if (single) limits.push(single);
  }

  if (limits.length === 0) return null;

  return { provider: "codex", updatedAt: now, limits };
}

// ── Claude normalization ────────────────────────────────────────────────

const CLAUDE_WINDOW_MAP: Record<string, { field: "primary" | "secondary"; durationMins: number }> =
  {
    five_hour: { field: "primary", durationMins: 300 },
    seven_day: { field: "secondary", durationMins: 10080 },
    seven_day_opus: { field: "secondary", durationMins: 10080 },
    seven_day_sonnet: { field: "secondary", durationMins: 10080 },
  };

/**
 * Merge a single Claude SDK `rate_limit_event` into an accumulated snapshot.
 *
 * Claude sends one rate-limit type per event (e.g. `five_hour` or `seven_day`),
 * so we accumulate primary and secondary windows across events.
 */
export function mergeClaudeRateLimitEvent(
  raw: unknown,
  accumulated: RateLimitsSnapshot | null,
  now: string,
): RateLimitsSnapshot | null {
  const root = asRecord(raw);
  if (!root) return null;

  const info = asRecord(root.rate_limit_info);
  if (!info) return null;

  const rateLimitType = asString(info.rateLimitType);
  const utilization = asNumber(info.utilization);

  if (!rateLimitType || utilization === null) return null;

  const mapping = CLAUDE_WINDOW_MAP[rateLimitType];
  if (!mapping) {
    // Unknown or skipped type (e.g. "overage") — pass through existing state
    return accumulated ?? null;
  }

  const window: RateLimitWindow = {
    usedPercent: utilization,
    windowDurationMins: mapping.durationMins,
    resetsAt: asNumber(info.resetsAt) ?? 0,
  };

  const previous = accumulated?.limits[0] ?? null;
  const primary = mapping.field === "primary" ? window : (previous?.primary ?? null);
  const secondary = mapping.field === "secondary" ? window : (previous?.secondary ?? null);

  const entry: RateLimitEntry = {
    limitId: "claude",
    limitName: null,
    primary,
    secondary,
  };

  return { provider: "claudeAgent", updatedAt: now, limits: [entry] };
}
