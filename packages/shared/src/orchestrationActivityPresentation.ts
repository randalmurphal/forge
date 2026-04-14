import type { OrchestrationThreadActivity } from "@forgetools/contracts";

import { asRecord, asTrimmedString } from "./narrowing";

export type OrchestrationActivityVisibility = "row" | "state-only" | "ignore";

export interface OrchestrationActivityPresentation {
  readonly visibility: OrchestrationActivityVisibility;
  readonly assistantBoundary: boolean;
}

const ROW_BOUNDARY: OrchestrationActivityPresentation = {
  visibility: "row",
  assistantBoundary: true,
};

const ROW_INLINE: OrchestrationActivityPresentation = {
  visibility: "row",
  assistantBoundary: false,
};

const STATE_ONLY: OrchestrationActivityPresentation = {
  visibility: "state-only",
  assistantBoundary: false,
};

const IGNORE: OrchestrationActivityPresentation = {
  visibility: "ignore",
  assistantBoundary: false,
};

export function classifyOrchestrationActivityPresentation(
  activity: OrchestrationThreadActivity,
): OrchestrationActivityPresentation {
  switch (activity.kind) {
    case "tool.output.delta":
    case "tool.terminal.interaction":
      return STATE_ONLY;

    case "tool.started":
    case "tool.updated":
    case "tool.completed":
    case "request.opened":
    case "user-input.requested":
    case "hook.started":
    case "hook.completed":
    case "runtime.error":
      return ROW_BOUNDARY;

    case "runtime.warning":
      return ROW_INLINE;

    case "mcp.status.updated": {
      const payload = asRecord(activity.payload);
      const status = asTrimmedString(payload?.status);
      if (status === "failed") {
        return ROW_BOUNDARY;
      }
      return IGNORE;
    }

    default:
      return ROW_INLINE;
  }
}

export function isAssistantBoundaryActivity(activity: OrchestrationThreadActivity): boolean {
  return classifyOrchestrationActivityPresentation(activity).assistantBoundary;
}

export function shouldPersistOrchestrationActivity(activity: OrchestrationThreadActivity): boolean {
  return classifyOrchestrationActivityPresentation(activity).visibility !== "ignore";
}
