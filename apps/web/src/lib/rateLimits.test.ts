import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitsSnapshot } from "@forgetools/contracts";

import { deriveRateLimitDisplay, formatResetTime } from "./rateLimits";

function makeSnapshot(limits: RateLimitsSnapshot["limits"]): RateLimitsSnapshot {
  return {
    provider: "claudeAgent",
    updatedAt: "2026-04-10T12:00:00.000Z",
    limits,
  };
}

describe("deriveRateLimitDisplay", () => {
  it("single entry with both windows — primary higher", () => {
    const result = deriveRateLimitDisplay(
      makeSnapshot([
        {
          limitId: "limit-1",
          limitName: "Standard",
          primary: { usedPercent: 72, windowDurationMins: 300, resetsAt: 1000 },
          secondary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: 2000 },
        },
      ]),
    );

    expect(result.primaryPercent).toBe(72);
    expect(result.secondaryPercent).toBe(45);
    expect(result.maxPercent).toBe(72);
    expect(result.constrainedWindow).toBe("5h");
    expect(result.resetsAt).toBe(1000);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      limitId: "limit-1",
      limitName: "Standard",
      primaryPercent: 72,
      secondaryPercent: 45,
      primaryResetsAt: 1000,
      secondaryResetsAt: 2000,
    });
  });

  it("secondary higher than primary — constrainedWindow is 7d", () => {
    const result = deriveRateLimitDisplay(
      makeSnapshot([
        {
          limitId: "limit-1",
          limitName: "Standard",
          primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1000 },
          secondary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: 5000 },
        },
      ]),
    );

    expect(result.primaryPercent).toBe(30);
    expect(result.secondaryPercent).toBe(80);
    expect(result.maxPercent).toBe(80);
    expect(result.constrainedWindow).toBe("7d");
    expect(result.resetsAt).toBe(5000);
  });

  it("multiple entries — picks max from each window independently", () => {
    const result = deriveRateLimitDisplay(
      makeSnapshot([
        {
          limitId: "main",
          limitName: "Main",
          primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1000 },
          secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 2000 },
        },
        {
          limitId: "sub",
          limitName: "Sub-limit",
          primary: { usedPercent: 88, windowDurationMins: 300, resetsAt: 3000 },
          secondary: { usedPercent: 62, windowDurationMins: 10080, resetsAt: 4000 },
        },
      ]),
    );

    expect(result.primaryPercent).toBe(88);
    expect(result.secondaryPercent).toBe(62);
    expect(result.maxPercent).toBe(88);
    expect(result.constrainedWindow).toBe("5h");
    expect(result.resetsAt).toBe(3000);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.limitId).toBe("main");
    expect(result.entries[1]!.limitId).toBe("sub");
  });

  it("entry with only primary — secondary stays null", () => {
    const result = deriveRateLimitDisplay(
      makeSnapshot([
        {
          limitId: "limit-1",
          limitName: "Primary Only",
          primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: 1000 },
          secondary: null,
        },
      ]),
    );

    expect(result.primaryPercent).toBe(60);
    expect(result.secondaryPercent).toBeNull();
    expect(result.maxPercent).toBe(60);
    expect(result.constrainedWindow).toBe("5h");
    expect(result.resetsAt).toBe(1000);
    expect(result.entries[0]!.secondaryPercent).toBeNull();
    expect(result.entries[0]!.secondaryResetsAt).toBeNull();
  });

  it("entry with only secondary — primary stays null, constrainedWindow is 7d", () => {
    const result = deriveRateLimitDisplay(
      makeSnapshot([
        {
          limitId: "limit-1",
          limitName: "Secondary Only",
          primary: null,
          secondary: { usedPercent: 75, windowDurationMins: 10080, resetsAt: 5000 },
        },
      ]),
    );

    expect(result.primaryPercent).toBeNull();
    expect(result.secondaryPercent).toBe(75);
    expect(result.maxPercent).toBe(75);
    expect(result.constrainedWindow).toBe("7d");
    expect(result.resetsAt).toBe(5000);
    expect(result.entries[0]!.primaryPercent).toBeNull();
    expect(result.entries[0]!.primaryResetsAt).toBeNull();
  });

  it("empty limits array — maxPercent is 0, both percents null", () => {
    const result = deriveRateLimitDisplay(makeSnapshot([]));

    expect(result.primaryPercent).toBeNull();
    expect(result.secondaryPercent).toBeNull();
    expect(result.maxPercent).toBe(0);
    expect(result.constrainedWindow).toBe("5h");
    expect(result.resetsAt).toBeNull();
    expect(result.entries).toHaveLength(0);
  });

  it("equal primary and secondary — primary wins ties (constrainedWindow is 5h)", () => {
    const result = deriveRateLimitDisplay(
      makeSnapshot([
        {
          limitId: "limit-1",
          limitName: "Equal",
          primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1000 },
          secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 2000 },
        },
      ]),
    );

    expect(result.primaryPercent).toBe(50);
    expect(result.secondaryPercent).toBe(50);
    expect(result.maxPercent).toBe(50);
    expect(result.constrainedWindow).toBe("5h");
    expect(result.resetsAt).toBe(1000);
  });

  it("handles usedPercent above 100 without clamping", () => {
    const result = deriveRateLimitDisplay(
      makeSnapshot([
        {
          limitId: "limit-1",
          limitName: null,
          primary: { usedPercent: 120, windowDurationMins: 300, resetsAt: 1000 },
          secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 2000 },
        },
      ]),
    );

    // maxPercent passes through the raw value — UI component is responsible for clamping display
    expect(result.maxPercent).toBe(120);
    expect(result.primaryPercent).toBe(120);
    expect(result.constrainedWindow).toBe("5h");
  });

  it("handles entries with usedPercent of 0", () => {
    const result = deriveRateLimitDisplay(
      makeSnapshot([
        {
          limitId: "limit-1",
          limitName: null,
          primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1000 },
          secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 2000 },
        },
      ]),
    );

    expect(result.maxPercent).toBe(0);
    expect(result.primaryPercent).toBe(0);
    expect(result.secondaryPercent).toBe(0);
    expect(result.entries).toHaveLength(1);
  });

  it("handles entry with resetsAt of 0", () => {
    const result = deriveRateLimitDisplay(
      makeSnapshot([
        {
          limitId: "limit-1",
          limitName: null,
          primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 0 },
          secondary: null,
        },
      ]),
    );

    expect(result.resetsAt).toBe(0);
    expect(result.entries[0]!.primaryResetsAt).toBe(0);
  });
});

describe("formatResetTime", () => {
  const NOW_MS = 1_712_750_400_000; // fixed reference point
  const NOW_EPOCH_SECONDS = NOW_MS / 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("past time returns 'now'", () => {
    expect(formatResetTime(NOW_EPOCH_SECONDS - 60)).toBe("now");
  });

  it("30 seconds away returns '<1m'", () => {
    expect(formatResetTime(NOW_EPOCH_SECONDS + 30)).toBe("<1m");
  });

  it("5 minutes away returns '5m'", () => {
    expect(formatResetTime(NOW_EPOCH_SECONDS + 5 * 60)).toBe("5m");
  });

  it("45 minutes away returns '45m'", () => {
    expect(formatResetTime(NOW_EPOCH_SECONDS + 45 * 60)).toBe("45m");
  });

  it("2 hours 14 minutes away returns '2h 14m'", () => {
    expect(formatResetTime(NOW_EPOCH_SECONDS + 2 * 3600 + 14 * 60)).toBe("2h 14m");
  });

  it("3 days 8 hours away returns '3d 8h'", () => {
    expect(formatResetTime(NOW_EPOCH_SECONDS + 3 * 86400 + 8 * 3600)).toBe("3d 8h");
  });

  it("exactly 1 hour returns '1h 0m'", () => {
    expect(formatResetTime(NOW_EPOCH_SECONDS + 3600)).toBe("1h 0m");
  });

  it("exactly 48 hours returns '2d 0h'", () => {
    expect(formatResetTime(NOW_EPOCH_SECONDS + 48 * 3600)).toBe("2d 0h");
  });
});
