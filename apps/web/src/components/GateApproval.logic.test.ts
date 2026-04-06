import { PhaseRunId, ThreadId } from "@forgetools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  approveGate,
  correctGate,
  deriveGateApprovalChangesSummary,
  deriveGateApprovalSummaryMarkdown,
  deriveGateApprovalUnresolvedItems,
  rejectGate,
  resolveGateApprovalShortcut,
  selectGateApprovalQualityChecks,
} from "./GateApproval.logic";

describe("GateApproval.logic", () => {
  it("derives summary, unresolved items, and change summaries from schema output", () => {
    const output = {
      kind: "schema" as const,
      summaryMarkdown: "Reviewed the implementation and found one open question.",
      structuredData: {
        unresolvedItems: ["Auth fallback behavior is still ambiguous."],
        changesSummary: ["4 files changed", "Added auth regression coverage"],
      },
      rawContent: "{}",
    };

    expect(deriveGateApprovalSummaryMarkdown(output)).toBe(
      "Reviewed the implementation and found one open question.",
    );
    expect(deriveGateApprovalUnresolvedItems(output)).toEqual([
      "Auth fallback behavior is still ambiguous.",
    ]);
    expect(deriveGateApprovalChangesSummary(output)).toEqual([
      "4 files changed",
      "Added auth regression coverage",
    ]);
  });

  it("prefers gate-level quality check results when available", () => {
    expect(
      selectGateApprovalQualityChecks({
        gateQualityCheckResults: [{ check: "test", passed: false, output: "1 failed" }],
        phaseQualityChecks: [{ check: "lint", passed: true }],
      }),
    ).toEqual([{ check: "test", passed: false, output: "1 failed" }]);
  });

  it("filters keyboard shortcuts when focus is inside editable inputs", () => {
    expect(resolveGateApprovalShortcut({ key: "a" })).toBe("approve");
    expect(resolveGateApprovalShortcut({ key: "r" })).toBe("reject");
    expect(resolveGateApprovalShortcut({ key: "a", targetTagName: "textarea" })).toBe(null);
    expect(resolveGateApprovalShortcut({ key: "r", isContentEditable: true })).toBe(null);
  });

  it("dispatches approve and reject actions through the existing rpc client", async () => {
    const client = {
      thread: {
        correct: vi.fn(),
      },
      gate: {
        approve: vi.fn().mockResolvedValue({ sequence: 1 }),
        reject: vi.fn().mockResolvedValue({ sequence: 2 }),
      },
    };

    await approveGate({
      client,
      threadId: ThreadId.makeUnsafe("thread-1"),
      phaseRunId: PhaseRunId.makeUnsafe("phase-1"),
    });
    await rejectGate({
      client,
      threadId: ThreadId.makeUnsafe("thread-1"),
      phaseRunId: PhaseRunId.makeUnsafe("phase-1"),
      reason: "Stop here and escalate the ambiguity.",
    });

    expect(client.gate.approve).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      phaseRunId: PhaseRunId.makeUnsafe("phase-1"),
    });
    expect(client.gate.reject).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      phaseRunId: PhaseRunId.makeUnsafe("phase-1"),
      correction: "Stop here and escalate the ambiguity.",
    });
  });

  it("posts a correction and then rejects the gate to retry", async () => {
    const client = {
      thread: {
        correct: vi.fn().mockResolvedValue({ sequence: 1 }),
      },
      gate: {
        approve: vi.fn(),
        reject: vi.fn().mockResolvedValue({ sequence: 2 }),
      },
    };

    await correctGate({
      client,
      threadId: ThreadId.makeUnsafe("thread-1"),
      phaseRunId: PhaseRunId.makeUnsafe("phase-1"),
      correction: "Retry with the auth fallback disabled.",
    });

    expect(client.thread.correct).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      content: "Retry with the auth fallback disabled.",
    });
    expect(client.gate.reject).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      phaseRunId: PhaseRunId.makeUnsafe("phase-1"),
    });
  });
});
