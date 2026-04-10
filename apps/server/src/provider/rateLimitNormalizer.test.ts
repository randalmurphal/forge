import { describe, expect, it } from "vitest";

import { mergeClaudeRateLimitEvent, normalizeCodexRateLimits } from "./rateLimitNormalizer.ts";

const NOW = "2026-04-10T12:00:00.000Z";

// ── Codex fixtures ──────────────────────────────────────────────────────

const codexPrimaryWindow = {
  usedPercent: 5,
  windowDurationMins: 300,
  resetsAt: 1775803864,
};

const codexSecondaryWindow = {
  usedPercent: 3,
  windowDurationMins: 10080,
  resetsAt: 1776372636,
};

const codexMainEntry = {
  limitId: "codex",
  limitName: null,
  primary: codexPrimaryWindow,
  secondary: codexSecondaryWindow,
  credits: { hasCredits: false, unlimited: false, balance: "0" },
  planType: "pro",
};

const codexBengalfoxEntry = {
  limitId: "codex_bengalfox",
  limitName: "GPT-5.3-Codex-Spark",
  primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1775809666 },
  secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1776396466 },
  credits: null,
  planType: "pro",
};

const fullCodexPayload = {
  rateLimits: codexMainEntry,
  rateLimitsByLimitId: {
    codex: codexMainEntry,
    codex_bengalfox: codexBengalfoxEntry,
  },
};

// ── Claude fixtures ─────────────────────────────────────────────────────

function claudeEvent(rateLimitType: string, utilization: number, resetsAt = 1775800000) {
  return {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt,
      rateLimitType,
      utilization,
    },
    uuid: "test-uuid",
    session_id: "test-session",
  };
}

// ── normalizeCodexRateLimits ────────────────────────────────────────────

describe("normalizeCodexRateLimits", () => {
  it("extracts all entries from rateLimitsByLimitId", () => {
    const result = normalizeCodexRateLimits(fullCodexPayload, NOW);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("codex");
    expect(result!.updatedAt).toBe(NOW);
    expect(result!.limits).toHaveLength(2);

    const mainEntry = result!.limits.find((e) => e.limitId === "codex");
    expect(mainEntry).toEqual({
      limitId: "codex",
      limitName: null,
      primary: codexPrimaryWindow,
      secondary: codexSecondaryWindow,
    });

    const bengalfoxEntry = result!.limits.find((e) => e.limitId === "codex_bengalfox");
    expect(bengalfoxEntry).toEqual({
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1775809666 },
      secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1776396466 },
    });
  });

  it("falls back to single rateLimits entry when rateLimitsByLimitId is absent", () => {
    const payload = { rateLimits: codexMainEntry };
    const result = normalizeCodexRateLimits(payload, NOW);

    expect(result).not.toBeNull();
    expect(result!.limits).toHaveLength(1);
    expect(result!.limits[0]!.limitId).toBe("codex");
    expect(result!.limits[0]!.primary).toEqual(codexPrimaryWindow);
    expect(result!.limits[0]!.secondary).toEqual(codexSecondaryWindow);
  });

  it("returns null for null input", () => {
    expect(normalizeCodexRateLimits(null, NOW)).toBeNull();
  });

  it("returns null for non-object input (string)", () => {
    expect(normalizeCodexRateLimits("not an object", NOW)).toBeNull();
  });

  it("returns null for non-object input (number)", () => {
    expect(normalizeCodexRateLimits(42, NOW)).toBeNull();
  });

  it("returns null for non-object input (array)", () => {
    expect(normalizeCodexRateLimits([1, 2, 3], NOW)).toBeNull();
  });

  it("returns null when entry has neither primary nor secondary windows", () => {
    const payload = {
      rateLimits: {
        limitId: "codex",
        limitName: null,
        primary: null,
        secondary: null,
      },
    };
    expect(normalizeCodexRateLimits(payload, NOW)).toBeNull();
  });

  it("skips entry when a window is missing required fields", () => {
    const payload = {
      rateLimits: {
        limitId: "codex",
        limitName: null,
        // primary missing resetsAt
        primary: { usedPercent: 10, windowDurationMins: 300 },
        // secondary missing entirely
        secondary: null,
      },
    };
    // primary is incomplete (missing resetsAt) so extractWindow returns null
    // secondary is null, so both windows are null => entry skipped => result null
    expect(normalizeCodexRateLimits(payload, NOW)).toBeNull();
  });

  it("keeps entry when only one window is valid", () => {
    const payload = {
      rateLimits: {
        limitId: "codex",
        limitName: null,
        primary: codexPrimaryWindow,
        secondary: null,
      },
    };
    const result = normalizeCodexRateLimits(payload, NOW);

    expect(result).not.toBeNull();
    expect(result!.limits).toHaveLength(1);
    expect(result!.limits[0]!.primary).toEqual(codexPrimaryWindow);
    expect(result!.limits[0]!.secondary).toBeNull();
  });

  it("skips entries without a limitId in rateLimitsByLimitId", () => {
    const payload = {
      rateLimitsByLimitId: {
        good: codexMainEntry,
        bad: { limitName: "no-id", primary: codexPrimaryWindow, secondary: null },
      },
    };
    const result = normalizeCodexRateLimits(payload, NOW);

    expect(result).not.toBeNull();
    expect(result!.limits).toHaveLength(1);
    expect(result!.limits[0]!.limitId).toBe("codex");
  });

  it("returns null for empty object", () => {
    expect(normalizeCodexRateLimits({}, NOW)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(normalizeCodexRateLimits(undefined, NOW)).toBeNull();
  });

  it("returns null when all entries in rateLimitsByLimitId are invalid", () => {
    const payload = {
      rateLimitsByLimitId: {
        bad1: { limitName: "no-id", primary: codexPrimaryWindow, secondary: null },
        bad2: { limitId: "ok-id", primary: null, secondary: null },
      },
    };
    expect(normalizeCodexRateLimits(payload, NOW)).toBeNull();
  });

  it("rejects NaN and Infinity in window fields", () => {
    const payload = {
      rateLimits: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: NaN, windowDurationMins: 300, resetsAt: 100 },
        secondary: { usedPercent: 5, windowDurationMins: Infinity, resetsAt: 200 },
      },
    };
    // Both windows are invalid: NaN in primary, Infinity in secondary
    expect(normalizeCodexRateLimits(payload, NOW)).toBeNull();
  });
});

// ── mergeClaudeRateLimitEvent ───────────────────────────────────────────

describe("mergeClaudeRateLimitEvent", () => {
  it("produces snapshot with primary set from five_hour event (no accumulation)", () => {
    const result = mergeClaudeRateLimitEvent(claudeEvent("five_hour", 94), null, NOW);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("claudeAgent");
    expect(result!.updatedAt).toBe(NOW);
    expect(result!.limits).toHaveLength(1);
    expect(result!.limits[0]!.limitId).toBe("claude");
    expect(result!.limits[0]!.limitName).toBeNull();
    expect(result!.limits[0]!.primary).toEqual({
      usedPercent: 94,
      windowDurationMins: 300,
      resetsAt: 1775800000,
    });
    expect(result!.limits[0]!.secondary).toBeNull();
  });

  it("produces snapshot with secondary set from seven_day event (no accumulation)", () => {
    const result = mergeClaudeRateLimitEvent(claudeEvent("seven_day", 42, 1776000000), null, NOW);

    expect(result).not.toBeNull();
    expect(result!.limits[0]!.primary).toBeNull();
    expect(result!.limits[0]!.secondary).toEqual({
      usedPercent: 42,
      windowDurationMins: 10080,
      resetsAt: 1776000000,
    });
  });

  it("accumulates five_hour then seven_day into both windows", () => {
    const firstResult = mergeClaudeRateLimitEvent(claudeEvent("five_hour", 94), null, NOW);
    const secondResult = mergeClaudeRateLimitEvent(
      claudeEvent("seven_day", 42, 1776000000),
      firstResult,
      NOW,
    );

    expect(secondResult).not.toBeNull();
    expect(secondResult!.limits).toHaveLength(1);
    expect(secondResult!.limits[0]!.primary).toEqual({
      usedPercent: 94,
      windowDurationMins: 300,
      resetsAt: 1775800000,
    });
    expect(secondResult!.limits[0]!.secondary).toEqual({
      usedPercent: 42,
      windowDurationMins: 10080,
      resetsAt: 1776000000,
    });
  });

  it("maps seven_day_sonnet to secondary window", () => {
    const result = mergeClaudeRateLimitEvent(
      claudeEvent("seven_day_sonnet", 15, 1776500000),
      null,
      NOW,
    );

    expect(result).not.toBeNull();
    expect(result!.limits[0]!.primary).toBeNull();
    expect(result!.limits[0]!.secondary).toEqual({
      usedPercent: 15,
      windowDurationMins: 10080,
      resetsAt: 1776500000,
    });
  });

  it("maps seven_day_opus to secondary window", () => {
    const result = mergeClaudeRateLimitEvent(
      claudeEvent("seven_day_opus", 30, 1776500000),
      null,
      NOW,
    );

    expect(result).not.toBeNull();
    expect(result!.limits[0]!.secondary).toEqual({
      usedPercent: 30,
      windowDurationMins: 10080,
      resetsAt: 1776500000,
    });
  });

  it("returns accumulated unchanged for unknown rate limit type (overage)", () => {
    const accumulated = mergeClaudeRateLimitEvent(claudeEvent("five_hour", 50), null, NOW);
    const result = mergeClaudeRateLimitEvent(claudeEvent("overage", 100), accumulated, NOW);

    // Should pass through the existing accumulation
    expect(result).toEqual(accumulated);
  });

  it("returns null for unknown type when no accumulated state exists", () => {
    const result = mergeClaudeRateLimitEvent(claudeEvent("overage", 100), null, NOW);
    expect(result).toBeNull();
  });

  it("returns null for null input", () => {
    expect(mergeClaudeRateLimitEvent(null, null, NOW)).toBeNull();
  });

  it("returns null when rate_limit_info is missing", () => {
    const event = { type: "rate_limit_event" };
    expect(mergeClaudeRateLimitEvent(event, null, NOW)).toBeNull();
  });

  it("returns null when utilization is missing", () => {
    const event = {
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1775800000,
        rateLimitType: "five_hour",
        // no utilization
      },
    };
    expect(mergeClaudeRateLimitEvent(event, null, NOW)).toBeNull();
  });

  it("returns null when rateLimitType is missing", () => {
    const event = {
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1775800000,
        utilization: 50,
        // no rateLimitType
      },
    };
    expect(mergeClaudeRateLimitEvent(event, null, NOW)).toBeNull();
  });

  it("defaults resetsAt to 0 when absent from info", () => {
    const event = {
      rate_limit_info: {
        rateLimitType: "five_hour",
        utilization: 60,
        // no resetsAt
      },
    };
    const result = mergeClaudeRateLimitEvent(event, null, NOW);

    expect(result).not.toBeNull();
    expect(result!.limits[0]!.primary!.resetsAt).toBe(0);
  });

  it("overwrites the same window field on subsequent events", () => {
    const first = mergeClaudeRateLimitEvent(claudeEvent("five_hour", 50, 1000), null, NOW);
    const second = mergeClaudeRateLimitEvent(claudeEvent("five_hour", 80, 2000), first, NOW);

    expect(second).not.toBeNull();
    expect(second!.limits[0]!.primary).toEqual({
      usedPercent: 80,
      windowDurationMins: 300,
      resetsAt: 2000,
    });
    // secondary should remain null since it was never set
    expect(second!.limits[0]!.secondary).toBeNull();
  });

  it("preserves secondary when primary is overwritten in three-event sequence", () => {
    const first = mergeClaudeRateLimitEvent(claudeEvent("five_hour", 50, 1000), null, NOW);
    const second = mergeClaudeRateLimitEvent(claudeEvent("seven_day", 30, 5000), first, NOW);
    const third = mergeClaudeRateLimitEvent(claudeEvent("five_hour", 60, 1100), second, NOW);

    expect(third).not.toBeNull();
    expect(third!.limits[0]!.primary).toEqual({
      usedPercent: 60,
      windowDurationMins: 300,
      resetsAt: 1100,
    });
    // secondary should be preserved from the second event
    expect(third!.limits[0]!.secondary).toEqual({
      usedPercent: 30,
      windowDurationMins: 10080,
      resetsAt: 5000,
    });
  });

  it("returns null for undefined input", () => {
    expect(mergeClaudeRateLimitEvent(undefined, null, NOW)).toBeNull();
  });
});
