import { useMemo } from "react";
import { inferCheckpointTurnCountByTurnId } from "../session-logic";
import type { ThreadDiffsSlice, TurnDiffSummary } from "../types";

const EMPTY_SUMMARIES: TurnDiffSummary[] = [];

export function useTurnDiffSummaries(source: ThreadDiffsSlice | undefined) {
  const turnDiffSummaries = useMemo(
    () => source?.turnDiffSummaries ?? EMPTY_SUMMARIES,
    [source?.turnDiffSummaries],
  );

  const inferredCheckpointTurnCountByTurnId = useMemo(
    () => inferCheckpointTurnCountByTurnId(turnDiffSummaries),
    [turnDiffSummaries],
  );

  return { turnDiffSummaries, inferredCheckpointTurnCountByTurnId };
}
