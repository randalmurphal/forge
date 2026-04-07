import type { ProjectId, WorkflowId, WorkflowSummary } from "@forgetools/contracts";

export type WorkflowPickerCategory = "discussion" | "workflow";

export function resolveWorkflowPickerCategory(workflow: WorkflowSummary): WorkflowPickerCategory {
  return workflow.hasDeliberation ? "discussion" : "workflow";
}

export function compareWorkflowSummariesForPicker(
  left: WorkflowSummary,
  right: WorkflowSummary,
): number {
  const rankDifference = workflowPickerScopeRank(left) - workflowPickerScopeRank(right);
  if (rankDifference !== 0) {
    return rankDifference;
  }

  const nameComparison = left.name.localeCompare(right.name, undefined, {
    sensitivity: "base",
  });
  if (nameComparison !== 0) {
    return nameComparison;
  }

  return left.workflowId.localeCompare(right.workflowId);
}

function workflowPickerScopeRank(workflow: WorkflowSummary): number {
  if (workflow.builtIn) {
    return 0;
  }
  if (workflow.projectId !== null) {
    return 1;
  }
  return 2;
}

export function sortWorkflowSummariesForPicker(
  workflows: readonly WorkflowSummary[],
): WorkflowSummary[] {
  return workflows.toSorted(compareWorkflowSummariesForPicker);
}

export function filterWorkflowSummariesForProject(
  workflows: readonly WorkflowSummary[],
  projectId: ProjectId | null,
): WorkflowSummary[] {
  return workflows.filter(
    (workflow) =>
      workflow.builtIn || workflow.projectId === null || workflow.projectId === projectId,
  );
}

export function splitWorkflowsByCategory(input: {
  projectId: ProjectId | null;
  workflows: readonly WorkflowSummary[];
}): { discussions: WorkflowSummary[]; workflows: WorkflowSummary[] } {
  const all = sortWorkflowSummariesForPicker(
    filterWorkflowSummariesForProject(input.workflows, input.projectId),
  );
  return {
    discussions: all.filter((w) => resolveWorkflowPickerCategory(w) === "discussion"),
    workflows: all.filter((w) => resolveWorkflowPickerCategory(w) === "workflow"),
  };
}

export function resolveWorkflowPickerLabel(input: {
  selectedWorkflowId: WorkflowId | null;
  workflows: readonly WorkflowSummary[];
}): string {
  if (input.selectedWorkflowId === null) {
    return "(none)";
  }

  return (
    input.workflows.find((workflow) => workflow.workflowId === input.selectedWorkflowId)?.name ??
    "Workflow unavailable"
  );
}
