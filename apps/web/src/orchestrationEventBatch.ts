import { type ForgeEvent } from "@forgetools/contracts";

export interface OrchestrationEventBatchSummaryEntry {
  readonly sequence: number;
  readonly type: ForgeEvent["type"];
}

export function summarizeOrchestrationEventBatch(
  events: ReadonlyArray<ForgeEvent>,
): ReadonlyArray<OrchestrationEventBatchSummaryEntry> {
  return events.map((event) => ({
    sequence: event.sequence,
    type: event.type,
  }));
}

export function safelyApplyOrchestrationEventBatch<T>(input: {
  readonly events: ReadonlyArray<ForgeEvent>;
  readonly apply: () => T;
}):
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: unknown;
      readonly eventSummary: ReadonlyArray<OrchestrationEventBatchSummaryEntry>;
    } {
  try {
    return {
      ok: true,
      value: input.apply(),
    };
  } catch (error) {
    // Keep the logging payload tiny and deterministic. We only need enough context to identify
    // which live batch wedged the client so recovery can fall back to a fresh snapshot.
    return {
      ok: false,
      error,
      eventSummary: summarizeOrchestrationEventBatch(input.events),
    };
  }
}
