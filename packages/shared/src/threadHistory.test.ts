import { describe, expect, it } from "vitest";

import {
  buildProposedPlanHistoryKey,
  buildTurnDiffHistoryKey,
  compareProposedPlanHistoryEntries,
  compareTurnDiffHistoryEntries,
  findLatestProposedPlanById,
} from "./threadHistory";

describe("threadHistory", () => {
  it("builds stable proposed plan history keys from logical id and revision time", () => {
    expect(
      buildProposedPlanHistoryKey({
        id: "plan-1",
        updatedAt: "2026-04-14T00:00:00.000Z",
      }),
    ).toBe("plan-1::2026-04-14T00:00:00.000Z");
  });

  it("finds the latest proposed plan revision for a logical plan id", () => {
    const revisions = [
      { id: "plan-1", updatedAt: "2026-04-14T00:00:01.000Z", planMarkdown: "old" },
      { id: "plan-2", updatedAt: "2026-04-14T00:00:02.000Z", planMarkdown: "other" },
      { id: "plan-1", updatedAt: "2026-04-14T00:00:03.000Z", planMarkdown: "new" },
    ];

    expect(findLatestProposedPlanById(revisions, "plan-1")).toEqual(revisions[2]);
    expect(
      [...revisions]
        .toSorted(compareProposedPlanHistoryEntries)
        .map((entry) => `${entry.id}:${entry.updatedAt}`),
    ).toEqual([
      "plan-1:2026-04-14T00:00:01.000Z",
      "plan-2:2026-04-14T00:00:02.000Z",
      "plan-1:2026-04-14T00:00:03.000Z",
    ]);
  });

  it("builds distinct turn diff history keys for distinct diff snapshots", () => {
    const base = {
      turnId: "turn-1",
      completedAt: "2026-04-14T00:00:00.000Z",
      provenance: "agent",
      source: "native_turn_diff",
      coverage: "complete",
      status: "ready",
      checkpointTurnCount: 1,
      checkpointRef: "refs/forge/checkpoints/thread-1/turn/1",
    } as const;

    const first = buildTurnDiffHistoryKey({
      ...base,
      files: [{ path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 }],
    });
    const second = buildTurnDiffHistoryKey({
      ...base,
      files: [{ path: "src/app.ts", kind: "modified", additions: 2, deletions: 0 }],
    });

    expect(first).not.toBe(second);
    expect(
      [
        { ...base, files: [{ path: "b.ts", kind: "modified", additions: 1, deletions: 0 }] },
        { ...base, files: [{ path: "a.ts", kind: "modified", additions: 1, deletions: 0 }] },
      ].toSorted(compareTurnDiffHistoryEntries)[0]?.files[0]?.path,
    ).toBe("a.ts");
  });

  it("distinguishes checkpoint history revisions that share a turn id but not checkpoint metadata", () => {
    const base = {
      turnId: "turn-1",
      completedAt: "2026-04-14T00:00:00.000Z",
      provenance: "workspace",
      files: [],
    } as const;

    expect(
      buildTurnDiffHistoryKey({
        ...base,
        status: "missing",
        checkpointTurnCount: 1,
        checkpointRef: "refs/forge/checkpoints/thread-1/turn/1",
      }),
    ).not.toBe(
      buildTurnDiffHistoryKey({
        ...base,
        status: "ready",
        checkpointTurnCount: 1,
        checkpointRef: "refs/forge/checkpoints/thread-1/turn/1",
      }),
    );
  });
});
