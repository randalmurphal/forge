import {
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type TurnId,
  type ThreadId,
} from "@forgetools/contracts";
import { findLatestProposedPlanById } from "@forgetools/shared/threadHistory";

import type { ActivePlanState, LatestProposedPlanState, PendingApproval } from "./types";
import type { ProposedPlan } from "../types";
import { compareActivitiesByOrder } from "./utils";

export function requestKindFromRequestType(
  requestType: unknown,
): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActivePlanState | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const candidates = ordered.filter((activity) => {
    if (activity.kind !== "turn.plan.updated") {
      return false;
    }
    if (!latestTurnId) {
      return true;
    }
    return activity.turnId === latestTurnId;
  });
  const latest = candidates.at(-1);
  if (!latest) {
    return null;
  }
  const payload =
    latest.payload && typeof latest.payload === "object"
      ? (latest.payload as Record<string, unknown>)
      : null;
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps = rawPlan
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.step !== "string") {
        return null;
      }
      const status =
        record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
      return {
        step: record.step,
        status,
      };
    })
    .filter(
      (
        step,
      ): step is {
        step: string;
        status: "pending" | "inProgress" | "completed";
      } => step !== null,
    );
  if (steps.length === 0) {
    return null;
  }
  return {
    createdAt: latest.createdAt,
    turnId: latest.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    steps,
  };
}

function toLatestProposedPlanState(proposedPlan: ProposedPlan): LatestProposedPlanState {
  return {
    id: proposedPlan.id,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
  };
}

function compareProposedPlanRecency(left: ProposedPlan, right: ProposedPlan): number {
  return (
    left.updatedAt.localeCompare(right.updatedAt) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null {
  let latestPlan: ProposedPlan | null = null;
  let latestMatchingTurnPlan: ProposedPlan | null = null;

  for (const proposedPlan of proposedPlans) {
    if (latestPlan === null || compareProposedPlanRecency(proposedPlan, latestPlan) > 0) {
      latestPlan = proposedPlan;
    }
    if (
      latestTurnId &&
      proposedPlan.turnId === latestTurnId &&
      (latestMatchingTurnPlan === null ||
        compareProposedPlanRecency(proposedPlan, latestMatchingTurnPlan) > 0)
    ) {
      latestMatchingTurnPlan = proposedPlan;
    }
  }

  if (latestMatchingTurnPlan) {
    return toLatestProposedPlanState(latestMatchingTurnPlan);
  }

  if (!latestPlan) {
    return null;
  }

  return toLatestProposedPlanState(latestPlan);
}

export function findSidebarProposedPlan(input: {
  plansByThreadId: ReadonlyArray<{ id: string; proposedPlans: ReadonlyArray<ProposedPlan> }>;
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "sourceProposedPlan"> | null;
  latestTurnSettled: boolean;
  threadId: ThreadId | string | null | undefined;
}): LatestProposedPlanState | null {
  const activeThreadPlans =
    input.plansByThreadId.find((entry) => entry.id === input.threadId)?.proposedPlans ?? [];

  if (!input.latestTurnSettled) {
    const sourceProposedPlan = input.latestTurn?.sourceProposedPlan;
    if (sourceProposedPlan) {
      const sourcePlan = findLatestProposedPlanById(
        input.plansByThreadId.find((entry) => entry.id === sourceProposedPlan.threadId)
          ?.proposedPlans ?? [],
        sourceProposedPlan.planId,
      );
      if (sourcePlan) {
        return toLatestProposedPlanState(sourcePlan);
      }
    }
  }

  return findLatestProposedPlan(activeThreadPlans, input.latestTurn?.turnId ?? null);
}

export function hasActionableProposedPlan(
  proposedPlan: LatestProposedPlanState | Pick<ProposedPlan, "implementedAt"> | null,
): boolean {
  return proposedPlan !== null && proposedPlan.implementedAt === null;
}
