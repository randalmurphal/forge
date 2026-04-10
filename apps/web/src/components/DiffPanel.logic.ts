import type { OrchestrationAgentDiffCoverage } from "@forgetools/contracts";

export function resolveSelectedAgentCoverage(input: {
  readonly queriedCoverage: OrchestrationAgentDiffCoverage | undefined;
  readonly summaryCoverage: OrchestrationAgentDiffCoverage | undefined;
}): OrchestrationAgentDiffCoverage | undefined {
  return input.queriedCoverage ?? input.summaryCoverage;
}

export function shouldShowWorkspaceFallback(input: {
  readonly diffMode: "agent" | "workspace";
  readonly hasSelectedTurn: boolean;
  readonly selectedAgentCoverage: OrchestrationAgentDiffCoverage | undefined;
  readonly hasSelectedCheckpointRange: boolean;
  readonly hasFetchedAgentDiff: boolean;
}): boolean {
  return (
    input.diffMode === "agent" &&
    input.hasSelectedTurn &&
    input.selectedAgentCoverage === "unavailable" &&
    input.hasSelectedCheckpointRange &&
    input.hasFetchedAgentDiff
  );
}
