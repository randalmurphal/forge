import { ProjectId, WorkflowId, type WorkflowSummary } from "@forgetools/contracts";
import { describe, expect, it } from "vitest";
import {
  compareWorkflowSummariesForPicker,
  filterWorkflowSummariesForProject,
  resolveWorkflowPickerCategory,
  resolveWorkflowPickerLabel,
  sortWorkflowSummariesForPicker,
  splitWorkflowsByCategory,
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
    hasDeliberation: false,
    ...overrides,
  };
}

describe("sortWorkflowSummariesForPicker", () => {
  it("sorts built-in workflows ahead of project and global workflows", () => {
    const workflows = sortWorkflowSummariesForPicker([
      makeWorkflowSummary("project-review"),
      makeWorkflowSummary("project-checklist", { projectId: ProjectId.makeUnsafe("project-1") }),
      makeWorkflowSummary("build-loop", { builtIn: true }),
      makeWorkflowSummary("debate", { builtIn: true }),
    ]);

    expect(workflows.map((workflow) => workflow.workflowId)).toEqual([
      WorkflowId.makeUnsafe("build-loop"),
      WorkflowId.makeUnsafe("debate"),
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

describe("splitWorkflowsByCategory", () => {
  it("separates deliberation workflows into discussions and the rest into workflows", () => {
    const result = splitWorkflowsByCategory({
      projectId: ProjectId.makeUnsafe("project-1"),
      workflows: [
        makeWorkflowSummary("debate", { builtIn: true, hasDeliberation: true }),
        makeWorkflowSummary("interrogate", { builtIn: true, hasDeliberation: true }),
        makeWorkflowSummary("build-loop", { builtIn: true }),
        makeWorkflowSummary("implement", { builtIn: true }),
        makeWorkflowSummary("custom-discussion", { hasDeliberation: true }),
      ],
    });

    expect(result.discussions.map((w) => w.workflowId)).toEqual([
      WorkflowId.makeUnsafe("debate"),
      WorkflowId.makeUnsafe("interrogate"),
      WorkflowId.makeUnsafe("custom-discussion"),
    ]);
    expect(result.workflows.map((w) => w.workflowId)).toEqual([
      WorkflowId.makeUnsafe("build-loop"),
      WorkflowId.makeUnsafe("implement"),
    ]);
  });

  it("filters out workflows from other projects", () => {
    const result = splitWorkflowsByCategory({
      projectId: ProjectId.makeUnsafe("project-1"),
      workflows: [
        makeWorkflowSummary("debate", { builtIn: true, hasDeliberation: true }),
        makeWorkflowSummary("other-project-workflow", {
          projectId: ProjectId.makeUnsafe("project-2"),
        }),
      ],
    });

    expect(result.discussions.map((w) => w.workflowId)).toEqual([WorkflowId.makeUnsafe("debate")]);
    expect(result.workflows).toEqual([]);
  });
});

describe("resolveWorkflowPickerCategory", () => {
  it("classifies deliberation workflows as discussions", () => {
    expect(
      resolveWorkflowPickerCategory(
        makeWorkflowSummary("interrogate", { builtIn: true, hasDeliberation: true }),
      ),
    ).toBe("discussion");
  });

  it("classifies custom deliberation workflows as discussions", () => {
    expect(
      resolveWorkflowPickerCategory(makeWorkflowSummary("debate-copy", { hasDeliberation: true })),
    ).toBe("discussion");
  });

  it("classifies non-deliberation workflows as workflows", () => {
    expect(
      resolveWorkflowPickerCategory(makeWorkflowSummary("build-loop", { builtIn: true })),
    ).toBe("workflow");
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
