import type { OrchestrationThreadActivity, TurnId } from "@forgetools/contracts";

import type { DeriveWorkLogEntriesOptions, WorkLogEntry } from "./types";
import { bootstrapWorkLogProjectionState, deriveProjectedWorkLogEntries } from "./projector";

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  input: DeriveWorkLogEntriesOptions | TurnId | undefined,
): WorkLogEntry[] {
  const messages = typeof input === "object" && input !== null ? input.messages : undefined;
  const latestTurn =
    typeof input === "object" && input !== null ? (input.latestTurn ?? null) : null;
  const projection = bootstrapWorkLogProjectionState(activities, {
    messages,
    latestTurn,
  });
  return deriveProjectedWorkLogEntries(projection, input);
}
