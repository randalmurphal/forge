import {
  buildProposedPlanHistoryKey,
  buildTurnDiffHistoryKey,
  compareTurnDiffHistoryEntries,
} from "@forgetools/shared/threadHistory";

import type { TurnDiffSummary } from "./types";

export { buildProposedPlanHistoryKey, buildTurnDiffHistoryKey };

export function isRenderableAgentTurnDiffSummary(summary: TurnDiffSummary): boolean {
  return (
    summary.provenance === "agent" && summary.coverage !== "unavailable" && summary.files.length > 0
  );
}

export function deriveLatestAgentDiffSummariesByTurn(
  summaries: ReadonlyArray<TurnDiffSummary>,
): TurnDiffSummary[] {
  const byTurnId = new Map<string, TurnDiffSummary>();
  const ordered = [...summaries].toSorted(compareTurnDiffHistoryEntries);

  for (const summary of ordered) {
    byTurnId.set(summary.turnId, summary);
  }

  return [...byTurnId.values()];
}
