import type { WorkflowId, WorkflowSummary } from "@forgetools/contracts";

export const NO_WORKFLOW_VALUE = "__none__";

export function compareWorkflowSummariesForPicker(
  left: WorkflowSummary,
  right: WorkflowSummary,
): number {
  if (left.builtIn !== right.builtIn) {
    return left.builtIn ? -1 : 1;
  }

  const nameComparison = left.name.localeCompare(right.name, undefined, {
    sensitivity: "base",
  });
  if (nameComparison !== 0) {
    return nameComparison;
  }

  return left.workflowId.localeCompare(right.workflowId);
}

export function sortWorkflowSummariesForPicker(
  workflows: readonly WorkflowSummary[],
): WorkflowSummary[] {
  return workflows.toSorted(compareWorkflowSummariesForPicker);
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
