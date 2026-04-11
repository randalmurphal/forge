import { describe, expect, it, vi } from "vitest";

import {
  safelyApplyOrchestrationEventBatch,
  summarizeOrchestrationEventBatch,
} from "./orchestrationEventBatch";

describe("orchestrationEventBatch", () => {
  it("summarizes event sequences and types for logging", () => {
    const summary = summarizeOrchestrationEventBatch([
      makeEvent(11, "thread.activity-appended"),
      makeEvent(12, "thread.latest-turn-updated"),
    ]);

    expect(summary).toEqual([
      { sequence: 11, type: "thread.activity-appended" },
      { sequence: 12, type: "thread.latest-turn-updated" },
    ]);
  });

  it("returns a successful result when batch application succeeds", () => {
    const apply = vi.fn(() => "ok");

    const result = safelyApplyOrchestrationEventBatch({
      events: [makeEvent(5, "thread.activity-appended")],
      apply,
    });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      value: "ok",
    });
  });

  it("captures the triggering event summary when batch application throws", () => {
    const error = new Error("boom");

    const result = safelyApplyOrchestrationEventBatch({
      events: [makeEvent(21, "thread.activity-appended"), makeEvent(22, "thread.session-updated")],
      apply: () => {
        throw error;
      },
    });

    expect(result).toEqual({
      ok: false,
      error,
      eventSummary: [
        { sequence: 21, type: "thread.activity-appended" },
        { sequence: 22, type: "thread.session-updated" },
      ],
    });
  });
});

function makeEvent(sequence: number, type: string) {
  return {
    sequence,
    type,
  } as never;
}
