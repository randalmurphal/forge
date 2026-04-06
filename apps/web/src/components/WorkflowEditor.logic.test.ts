import {
  ProjectId,
  WorkflowId,
  WorkflowPhaseId,
  type WorkflowDefinition,
} from "@forgetools/contracts";
import { describe, expect, it } from "vitest";
import {
  appendWorkflowDraftPhase,
  buildWorkflowMutationDefinition,
  cloneWorkflowForEditing,
  createDefaultWorkflowPhase,
  createEmptyWorkflowDefinition,
  removeWorkflowDraftPhase,
  reorderWorkflowDraftPhases,
  resolveModelSelectionForEditor,
  resolvePreviousPhaseOptions,
  resolvePromptEditorValue,
  resolveWorkflowMutationKind,
  resolveWorkflowPromptOptions,
  resolveWorkflowQualityCheckOptions,
  resolveWorkflowScopeProjectId,
  setWorkflowPhaseDeliberation,
} from "./WorkflowEditor.logic";

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: WorkflowId.makeUnsafe("workflow-1"),
    name: "build-loop",
    description: "Workflow description",
    builtIn: false,
    phases: [
      {
        id: WorkflowPhaseId.makeUnsafe("phase-1"),
        name: "implement",
        type: "single-agent",
        agent: {
          prompt: "implement",
          output: { type: "conversation" },
        },
        gate: {
          after: "done",
          onFail: "retry",
          maxRetries: 3,
        },
      },
    ],
    createdAt: "2026-04-06T00:00:00.000Z",
    updatedAt: "2026-04-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("workflow editor draft helpers", () => {
  it("adds a phase and moves the previous terminal phase to auto-continue", () => {
    const next = appendWorkflowDraftPhase(makeWorkflow());

    expect(next.phases).toHaveLength(2);
    expect(next.phases[0]?.gate.after).toBe("auto-continue");
    expect(next.phases[1]?.gate.after).toBe("done");
  });

  it("removes a phase and restores the remaining last phase to done", () => {
    const draft = appendWorkflowDraftPhase(makeWorkflow());
    const removed = removeWorkflowDraftPhase(draft, draft.phases[1]!.id);

    expect(removed.phases).toHaveLength(1);
    expect(removed.phases[0]?.gate.after).toBe("done");
  });

  it("reorders phases by index", () => {
    const secondPhase = createDefaultWorkflowPhase({ index: 1 });
    const thirdPhase = createDefaultWorkflowPhase({ index: 2 });
    const draft = makeWorkflow({
      phases: [
        {
          ...makeWorkflow().phases[0]!,
          gate: { after: "auto-continue", onFail: "retry", maxRetries: 3 },
        },
        {
          ...secondPhase,
          name: "review",
          gate: { after: "auto-continue", onFail: "retry", maxRetries: 3 },
        },
        {
          ...thirdPhase,
          name: "finalize",
          gate: { after: "done", onFail: "stop", maxRetries: 0 },
        },
      ],
    });

    const reordered = reorderWorkflowDraftPhases(draft, 2, 0);

    expect(reordered.phases.map((phase) => phase.name)).toEqual([
      "finalize",
      "implement",
      "review",
    ]);
  });

  it("clones built-in workflows into editable copies with new ids", () => {
    const builtIn = makeWorkflow({
      builtIn: true,
      id: WorkflowId.makeUnsafe("workflow-built-in"),
      phases: [
        {
          id: WorkflowPhaseId.makeUnsafe("phase-built-in"),
          name: "review",
          type: "single-agent",
          agent: {
            prompt: "review",
            output: { type: "conversation" },
          },
          gate: {
            after: "done",
            onFail: "stop",
            maxRetries: 0,
          },
        },
      ],
    });

    const clone = cloneWorkflowForEditing(builtIn, "2026-04-06T12:00:00.000Z");

    expect(clone.builtIn).toBe(false);
    expect(clone.id).not.toBe(builtIn.id);
    expect(clone.phases[0]?.id).not.toBe(builtIn.phases[0]?.id);
    expect(clone.name).toBe("build-loop copy");
  });

  it("converts single-agent phases into deliberation phases with two participants", () => {
    const phase = makeWorkflow().phases[0]!;
    const next = setWorkflowPhaseDeliberation(phase, true);

    expect(next.type).toBe("multi-agent");
    expect(next.deliberation?.participants).toHaveLength(2);
    expect(next.deliberation?.participants[0]?.role).toBe("advocate");
    expect(next.deliberation?.participants[1]?.role).toBe("interrogator");
  });

  it("builds an updated workflow definition for saving", () => {
    const updated = buildWorkflowMutationDefinition(
      makeWorkflow({
        phases: [
          {
            ...makeWorkflow().phases[0]!,
            gate: {
              after: "quality-checks",
              onFail: "retry",
              maxRetries: 3,
              qualityChecks: [{ check: "test", required: true }],
            },
          },
        ],
      }),
      "2026-04-06T15:00:00.000Z",
    );

    expect(updated.updatedAt).toBe("2026-04-06T15:00:00.000Z");
    expect(updated.phases[0]?.gate.qualityChecks).toEqual([{ check: "test", required: true }]);
  });

  it("resolves create versus update workflow mutations correctly", () => {
    const draft = makeWorkflow();

    expect(
      resolveWorkflowMutationKind({
        routeWorkflowId: draft.id,
        sourceWorkflow: draft,
        draft,
      }),
    ).toBe("update");

    expect(
      resolveWorkflowMutationKind({
        routeWorkflowId: draft.id,
        sourceWorkflow: makeWorkflow({ builtIn: true }),
        draft: cloneWorkflowForEditing(makeWorkflow({ builtIn: true }), "2026-04-06T12:00:00.000Z"),
      }),
    ).toBe("create");
  });
});

describe("workflow editor option helpers", () => {
  it("collects prompt options from built-ins and draft workflows", () => {
    const prompts = resolveWorkflowPromptOptions({
      workflows: [
        makeWorkflow(),
        makeWorkflow({
          id: WorkflowId.makeUnsafe("workflow-2"),
          phases: [
            {
              id: WorkflowPhaseId.makeUnsafe("phase-2"),
              name: "review",
              type: "multi-agent",
              deliberation: {
                participants: [
                  {
                    role: "scrutinizer",
                    agent: {
                      prompt: "scrutinizer",
                      output: { type: "channel" },
                    },
                  },
                  {
                    role: "defender",
                    agent: {
                      prompt: "defender",
                      output: { type: "channel" },
                    },
                  },
                ],
                maxTurns: 20,
              },
              gate: {
                after: "done",
                onFail: "stop",
                maxRetries: 0,
              },
            },
          ],
        }),
      ],
    });

    expect(prompts).toContain("implement");
    expect(prompts).toContain("scrutinizer");
    expect(prompts).toContain("defender");
  });

  it("collects quality check options from workflow phases", () => {
    const checks = resolveWorkflowQualityCheckOptions({
      workflows: [
        makeWorkflow({
          phases: [
            {
              id: WorkflowPhaseId.makeUnsafe("phase-1"),
              name: "implement",
              type: "single-agent",
              agent: {
                prompt: "implement",
                output: { type: "conversation" },
              },
              gate: {
                after: "quality-checks",
                onFail: "retry",
                maxRetries: 3,
                qualityChecks: [
                  { check: "test", required: true },
                  { check: "lint", required: true },
                ],
              },
            },
          ],
        }),
      ],
    });

    expect(checks).toEqual(["lint", "test", "typecheck"]);
  });

  it("resolves previous phase names for go-back targets", () => {
    const workflow = makeWorkflow({
      phases: [
        { ...createDefaultWorkflowPhase({ index: 0 }), name: "plan" },
        { ...createDefaultWorkflowPhase({ index: 1 }), name: "implement" },
        { ...createDefaultWorkflowPhase({ index: 2 }), name: "review" },
      ],
    });

    expect(resolvePreviousPhaseOptions(workflow.phases, workflow.phases[2]!.id)).toEqual([
      "plan",
      "implement",
    ]);
  });

  it("returns the custom prompt sentinel when the prompt is not in the option list", () => {
    expect(resolvePromptEditorValue("my-custom-prompt", ["implement", "review"])).toBe(
      "__custom__",
    );
  });

  it("keeps project scope tied to the chosen project id", () => {
    const projectId = ProjectId.makeUnsafe("project-1");

    expect(resolveWorkflowScopeProjectId("global", projectId)).toBeNull();
    expect(resolveWorkflowScopeProjectId("project", projectId)).toBe(projectId);
  });

  it("falls back to the session model selection when a phase has no override", () => {
    const fallback = { provider: "codex" as const, model: "gpt-5.4" };

    expect(resolveModelSelectionForEditor(undefined, fallback)).toEqual(fallback);
    expect(
      resolveModelSelectionForEditor(
        { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        fallback,
      ),
    ).toEqual({ provider: "claudeAgent", model: "claude-sonnet-4-6" });
  });

  it("creates a valid empty workflow draft", () => {
    const draft = createEmptyWorkflowDefinition("2026-04-06T00:00:00.000Z");

    expect(draft.builtIn).toBe(false);
    expect(draft.phases).toHaveLength(1);
    expect(draft.createdAt).toBe("2026-04-06T00:00:00.000Z");
  });
});
