import { describe, expect, it } from "vitest";

import { resolveSelectedAgentCoverage, shouldShowWorkspaceFallback } from "./DiffPanel.logic";

describe("DiffPanel agent fallback logic", () => {
  it("prefers the turn summary coverage while the agent diff query is still loading", () => {
    expect(
      resolveSelectedAgentCoverage({
        queriedCoverage: undefined,
        summaryCoverage: "complete",
      }),
    ).toBe("complete");
  });

  it("does not show workspace fallback before the agent diff query resolves", () => {
    expect(
      shouldShowWorkspaceFallback({
        diffMode: "agent",
        hasSelectedTurn: true,
        selectedAgentCoverage: "unavailable",
        hasSelectedCheckpointRange: true,
        hasFetchedAgentDiff: false,
      }),
    ).toBe(false);
  });

  it("shows workspace fallback after the agent diff query resolves as unavailable", () => {
    expect(
      shouldShowWorkspaceFallback({
        diffMode: "agent",
        hasSelectedTurn: true,
        selectedAgentCoverage: "unavailable",
        hasSelectedCheckpointRange: true,
        hasFetchedAgentDiff: true,
      }),
    ).toBe(true);
  });
});
