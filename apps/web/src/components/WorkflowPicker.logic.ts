import type { ProjectId, WorkflowId, WorkflowSummary } from "@forgetools/contracts";

export const NO_WORKFLOW_VALUE = "__none__";

export interface WorkflowPickerSection {
  key: "built-in" | "project" | "global";
  label: string;
  workflows: WorkflowSummary[];
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

export function buildWorkflowPickerSections(input: {
  projectId: ProjectId | null;
  workflows: readonly WorkflowSummary[];
}): WorkflowPickerSection[] {
  const filteredWorkflows = sortWorkflowSummariesForPicker(
    filterWorkflowSummariesForProject(input.workflows, input.projectId),
  );

  const builtIn = filteredWorkflows.filter((workflow) => workflow.builtIn);
  const project = filteredWorkflows.filter(
    (workflow) => !workflow.builtIn && workflow.projectId !== null,
  );
  const global = filteredWorkflows.filter(
    (workflow) => !workflow.builtIn && workflow.projectId === null,
  );

  return [
    { key: "built-in", label: "Built-in", workflows: builtIn },
    { key: "project", label: "This project", workflows: project },
    { key: "global", label: "Global", workflows: global },
  ] satisfies WorkflowPickerSection[];
}

export function compactWorkflowPickerSections(
  sections: readonly WorkflowPickerSection[],
): WorkflowPickerSection[] {
  return sections.filter((section) => section.workflows.length > 0);
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
