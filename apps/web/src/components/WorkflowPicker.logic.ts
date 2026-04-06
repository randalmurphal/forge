import type { ProjectId, WorkflowId, WorkflowSummary } from "@forgetools/contracts";

export const NO_WORKFLOW_VALUE = "__none__";
const BUILT_IN_THINKING_WORKFLOW_SLUGS = new Set([
  "code-review",
  "debate",
  "explore",
  "interrogate",
  "refine-prompt",
]);

export type WorkflowPickerCategory = "implementation" | "thinking";

export interface WorkflowPickerSection {
  key: "built-in-implementation" | "built-in-thinking" | "project" | "global";
  label: string;
  workflows: WorkflowSummary[];
}

function normalizeWorkflowSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^workflow-built-in-/, "");
}

export function resolveWorkflowPickerCategory(workflow: WorkflowSummary): WorkflowPickerCategory {
  if (!workflow.builtIn) {
    return "implementation";
  }

  const workflowSlug = normalizeWorkflowSlug(workflow.workflowId);
  const workflowName = normalizeWorkflowSlug(workflow.name);
  if (
    BUILT_IN_THINKING_WORKFLOW_SLUGS.has(workflowSlug) ||
    BUILT_IN_THINKING_WORKFLOW_SLUGS.has(workflowName)
  ) {
    return "thinking";
  }

  return "implementation";
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

  const builtInImplementation = filteredWorkflows.filter(
    (workflow) => workflow.builtIn && resolveWorkflowPickerCategory(workflow) === "implementation",
  );
  const builtInThinking = filteredWorkflows.filter(
    (workflow) => workflow.builtIn && resolveWorkflowPickerCategory(workflow) === "thinking",
  );
  const project = filteredWorkflows.filter(
    (workflow) => !workflow.builtIn && workflow.projectId !== null,
  );
  const global = filteredWorkflows.filter(
    (workflow) => !workflow.builtIn && workflow.projectId === null,
  );

  return [
    {
      key: "built-in-implementation",
      label: "Built-in · Implementation",
      workflows: builtInImplementation,
    },
    {
      key: "built-in-thinking",
      label: "Built-in · Thinking",
      workflows: builtInThinking,
    },
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
