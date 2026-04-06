import { ProjectId, WorkflowId, type WorkflowSummary } from "@forgetools/contracts";
import { describe, expect, it } from "vitest";
import {
  buildWorkflowPickerSections,
  compactWorkflowPickerSections,
  compareWorkflowSummariesForPicker,
  filterWorkflowSummariesForProject,
  resolveWorkflowPickerCategory,
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
    projectId: null,
    ...overrides,
  };
}

describe("sortWorkflowSummariesForPicker", () => {
  it("sorts built-in workflows ahead of project and global workflows", () => {
    const workflows = sortWorkflowSummariesForPicker([
      makeWorkflowSummary("project-review"),
      makeWorkflowSummary("project-checklist", { projectId: ProjectId.makeUnsafe("project-1") }),
      makeWorkflowSummary("build-loop", { builtIn: true }),
      makeWorkflowSummary("code-review", { builtIn: true }),
    ]);

    expect(workflows.map((workflow) => workflow.workflowId)).toEqual([
      WorkflowId.makeUnsafe("build-loop"),
      WorkflowId.makeUnsafe("code-review"),
      WorkflowId.makeUnsafe("project-checklist"),
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

  it("prefers project workflows over global custom workflows", () => {
    expect(
      compareWorkflowSummariesForPicker(
        makeWorkflowSummary("workflow-global"),
        makeWorkflowSummary("workflow-project", { projectId: ProjectId.makeUnsafe("project-1") }),
      ),
    ).toBeGreaterThan(0);
  });
});

describe("filterWorkflowSummariesForProject", () => {
  it("keeps built-in, global, and matching-project workflows", () => {
    const workflows = filterWorkflowSummariesForProject(
      [
        makeWorkflowSummary("workflow-built-in", { builtIn: true }),
        makeWorkflowSummary("workflow-global"),
        makeWorkflowSummary("workflow-project", { projectId: ProjectId.makeUnsafe("project-1") }),
        makeWorkflowSummary("workflow-other-project", {
          projectId: ProjectId.makeUnsafe("project-2"),
        }),
      ],
      ProjectId.makeUnsafe("project-1"),
    );

    expect(workflows.map((workflow) => workflow.workflowId)).toEqual([
      WorkflowId.makeUnsafe("workflow-built-in"),
      WorkflowId.makeUnsafe("workflow-global"),
      WorkflowId.makeUnsafe("workflow-project"),
    ]);
  });
});

describe("buildWorkflowPickerSections", () => {
  it("splits built-in workflows into implementation and thinking sections before scope buckets", () => {
    const sections = buildWorkflowPickerSections({
      projectId: ProjectId.makeUnsafe("project-1"),
      workflows: [
        makeWorkflowSummary("workflow-global"),
        makeWorkflowSummary("workflow-built-in", { builtIn: true }),
        makeWorkflowSummary("workflow-built-in-interrogate", {
          builtIn: true,
          name: "interrogate",
        }),
        makeWorkflowSummary("workflow-project", { projectId: ProjectId.makeUnsafe("project-1") }),
      ],
    });

    expect(sections.map((section) => section.key)).toEqual([
      "built-in-implementation",
      "built-in-thinking",
      "project",
      "global",
    ]);
  });

  it("drops empty picker sections after grouping", () => {
    const sections = compactWorkflowPickerSections(
      buildWorkflowPickerSections({
        projectId: null,
        workflows: [makeWorkflowSummary("workflow-built-in", { builtIn: true })],
      }),
    );

    expect(sections).toEqual([
      expect.objectContaining({
        key: "built-in-implementation",
      }),
    ]);
  });
});

describe("resolveWorkflowPickerCategory", () => {
  it("classifies built-in deliberation workflows as thinking patterns", () => {
    expect(
      resolveWorkflowPickerCategory(
        makeWorkflowSummary("workflow-built-in-interrogate", {
          builtIn: true,
          name: "interrogate",
        }),
      ),
    ).toBe("thinking");
  });

  it("keeps mixed or implementation workflows in the implementation category", () => {
    expect(
      resolveWorkflowPickerCategory(
        makeWorkflowSummary("workflow-built-in-plan-then-implement", {
          builtIn: true,
          name: "plan-then-implement",
        }),
      ),
    ).toBe("implementation");
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
