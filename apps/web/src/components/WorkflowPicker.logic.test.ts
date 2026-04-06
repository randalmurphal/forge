import { WorkflowId, type WorkflowSummary } from "@forgetools/contracts";
import { describe, expect, it } from "vitest";
import {
  compareWorkflowSummariesForPicker,
  resolveWorkflowPickerLabel,
  sortWorkflowSummariesForPicker,
} from "./WorkflowPicker.logic";

function makeWorkflowSummary(
  workflowId: string,
  overrides: Partial<WorkflowSummary> = {},
): WorkflowSummary {
  return {
    workflowId: WorkflowId.makeUnsafe(workflowId),
    name: workflowId,
    description: `${workflowId} description`,
    builtIn: false,
    ...overrides,
  };
}

describe("sortWorkflowSummariesForPicker", () => {
  it("sorts built-in workflows ahead of non-built-in workflows", () => {
    const workflows = sortWorkflowSummariesForPicker([
      makeWorkflowSummary("project-review"),
      makeWorkflowSummary("build-loop", { builtIn: true }),
      makeWorkflowSummary("code-review", { builtIn: true }),
    ]);

    expect(workflows.map((workflow) => workflow.workflowId)).toEqual([
      WorkflowId.makeUnsafe("build-loop"),
      WorkflowId.makeUnsafe("code-review"),
      WorkflowId.makeUnsafe("project-review"),
    ]);
  });

  it("uses case-insensitive name order and workflow id as a stable tiebreaker", () => {
    const workflows = sortWorkflowSummariesForPicker([
      makeWorkflowSummary("workflow-b", { name: "Alpha" }),
      makeWorkflowSummary("workflow-a", { name: "alpha" }),
    ]);

    expect(workflows.map((workflow) => workflow.workflowId)).toEqual([
      WorkflowId.makeUnsafe("workflow-a"),
      WorkflowId.makeUnsafe("workflow-b"),
    ]);
  });
});

describe("compareWorkflowSummariesForPicker", () => {
  it("prefers built-in workflows when comparing two summaries", () => {
    expect(
      compareWorkflowSummariesForPicker(
        makeWorkflowSummary("workflow-user"),
        makeWorkflowSummary("workflow-built-in", { builtIn: true }),
      ),
    ).toBeGreaterThan(0);
  });
});

describe("resolveWorkflowPickerLabel", () => {
  it("returns (none) when no workflow is selected", () => {
    expect(resolveWorkflowPickerLabel({ selectedWorkflowId: null, workflows: [] })).toBe("(none)");
  });

  it("returns the selected workflow name when present", () => {
    const workflow = makeWorkflowSummary("build-loop", {
      builtIn: true,
      name: "Build Loop",
    });

    expect(
      resolveWorkflowPickerLabel({
        selectedWorkflowId: workflow.workflowId,
        workflows: [workflow],
      }),
    ).toBe("Build Loop");
  });

  it("surfaces an unavailable selection clearly", () => {
    expect(
      resolveWorkflowPickerLabel({
        selectedWorkflowId: WorkflowId.makeUnsafe("missing-workflow"),
        workflows: [],
      }),
    ).toBe("Workflow unavailable");
  });
});
