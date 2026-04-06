import type {
  GateAfter,
  GateOnFail,
  ModelSelection,
  ProjectId,
  QualityCheckReference,
  WorkflowDefinition,
  WorkflowPhase,
  WorkflowSummary,
} from "@forgetools/contracts";
import { WorkflowId, WorkflowPhaseId, defaultSandboxMode } from "@forgetools/contracts";
import { randomUUID } from "../lib/utils";

export const DEFAULT_WORKFLOW_PROMPT_OPTIONS = [
  "implement",
  "review",
  "finalize",
  "advocate",
  "interrogator",
  "scrutinizer",
  "defender",
  "critic",
  "connector",
  "synthesize",
  "evaluator",
  "refiner",
] as const;

export const DEFAULT_WORKFLOW_CHECK_OPTIONS = ["test", "lint", "typecheck"] as const;

export const WORKFLOW_GATE_AFTER_OPTIONS = [
  { value: "auto-continue", label: "Auto-continue" },
  { value: "quality-checks", label: "Run quality checks" },
  { value: "human-approval", label: "Human approval" },
  { value: "done", label: "Done" },
] as const satisfies ReadonlyArray<{ value: GateAfter; label: string }>;

export const WORKFLOW_GATE_ON_FAIL_OPTIONS = [
  { value: "retry", label: "Retry this phase" },
  { value: "go-back-to", label: "Go back to phase" },
  { value: "stop", label: "Stop workflow" },
] as const satisfies ReadonlyArray<{ value: GateOnFail; label: string }>;

export const WORKFLOW_EXECUTION_KIND_OPTIONS = [
  { value: "agent", label: "Agent" },
  { value: "automated", label: "Automated" },
  { value: "human", label: "Human" },
] as const;

export type WorkflowExecutionKind = (typeof WORKFLOW_EXECUTION_KIND_OPTIONS)[number]["value"];
export type WorkflowMutationKind = "create" | "update";

function workflowEditorScopeRank(input: { builtIn: boolean; projectId: ProjectId | null }): number {
  if (input.builtIn) {
    return 0;
  }
  if (input.projectId !== null) {
    return 1;
  }
  return 2;
}

function newWorkflowId() {
  return WorkflowId.makeUnsafe(`workflow-${randomUUID()}`);
}

function newWorkflowPhaseId() {
  return WorkflowPhaseId.makeUnsafe(`phase-${randomUUID()}`);
}

function createQualityCheckReference(check: string): QualityCheckReference {
  return {
    check,
    required: true,
  };
}

function normalizeWorkflowTerminalPhase(phases: readonly WorkflowPhase[]): WorkflowPhase[] {
  if (phases.length === 0) {
    return [];
  }

  const hasDonePhase = phases.some((phase) => phase.gate.after === "done");
  if (hasDonePhase) {
    return [...phases];
  }

  return phases.map((phase, index) =>
    index === phases.length - 1
      ? {
          ...phase,
          gate: {
            ...phase.gate,
            after: "done",
          },
        }
      : phase,
  );
}

function normalizeWorkflowPhaseChecks(phase: WorkflowPhase): WorkflowPhase {
  if (phase.type === "automated") {
    return phase.gate.after === "quality-checks"
      ? {
          ...phase,
          qualityChecks: phase.qualityChecks ?? [],
          gate: {
            ...phase.gate,
            qualityChecks: undefined,
          },
        }
      : phase;
  }

  return phase.gate.after === "quality-checks"
    ? {
        ...phase,
        qualityChecks: undefined,
        gate: {
          ...phase.gate,
          qualityChecks: phase.gate.qualityChecks ?? [],
        },
      }
    : {
        ...phase,
        qualityChecks: undefined,
        gate: {
          ...phase.gate,
          qualityChecks: undefined,
        },
      };
}

export function createDefaultWorkflowPhase(input?: {
  index?: number;
  type?: WorkflowPhase["type"];
}): WorkflowPhase {
  const index = input?.index ?? 0;
  const type = input?.type ?? "single-agent";

  if (type === "multi-agent") {
    return {
      id: newWorkflowPhaseId(),
      name: `phase-${index + 1}`,
      type: "multi-agent",
      sandboxMode: defaultSandboxMode("multi-agent"),
      deliberation: {
        participants: [
          {
            role: "advocate",
            agent: {
              prompt: "advocate",
              output: { type: "channel" },
            },
          },
          {
            role: "interrogator",
            agent: {
              prompt: "interrogator",
              output: { type: "channel" },
            },
          },
        ],
        maxTurns: 20,
      },
      gate: {
        after: "done",
        onFail: "retry",
        maxRetries: 3,
      },
    };
  }

  if (type === "automated") {
    return {
      id: newWorkflowPhaseId(),
      name: `phase-${index + 1}`,
      type: "automated",
      sandboxMode: defaultSandboxMode("automated"),
      qualityChecks: [createQualityCheckReference("test")],
      gate: {
        after: "quality-checks",
        onFail: "stop",
        maxRetries: 0,
      },
    };
  }

  if (type === "human") {
    return {
      id: newWorkflowPhaseId(),
      name: `phase-${index + 1}`,
      type: "human",
      sandboxMode: defaultSandboxMode("human"),
      gate: {
        after: "human-approval",
        onFail: "stop",
        maxRetries: 0,
      },
    };
  }

  return {
    id: newWorkflowPhaseId(),
    name: `phase-${index + 1}`,
    type: "single-agent",
    sandboxMode: defaultSandboxMode("single-agent"),
    agent: {
      prompt: "implement",
      output: { type: "conversation" },
    },
    gate: {
      after: "done",
      onFail: "retry",
      maxRetries: 3,
    },
  };
}

export function createEmptyWorkflowDefinition(now: string): WorkflowDefinition {
  return {
    id: newWorkflowId(),
    name: "",
    description: "",
    builtIn: false,
    projectId: null,
    phases: [createDefaultWorkflowPhase()],
    createdAt: now,
    updatedAt: now,
  };
}

export function cloneWorkflowForEditing(
  workflow: WorkflowDefinition,
  now: string,
): WorkflowDefinition {
  return {
    ...workflow,
    id: newWorkflowId(),
    name: `${workflow.name} copy`,
    builtIn: false,
    projectId: workflow.projectId,
    phases: workflow.phases.map((phase) => ({
      ...phase,
      id: newWorkflowPhaseId(),
    })),
    createdAt: now,
    updatedAt: now,
  };
}

export function sortWorkflowDefinitionsForEditor(
  workflows: readonly WorkflowDefinition[],
): WorkflowDefinition[] {
  return [...workflows].toSorted((left, right) => {
    const rankDifference = workflowEditorScopeRank(left) - workflowEditorScopeRank(right);
    if (rankDifference !== 0) {
      return rankDifference;
    }

    const byName = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    if (byName !== 0) {
      return byName;
    }

    return left.id.localeCompare(right.id);
  });
}

export function toWorkflowSummaryRecord(workflow: WorkflowDefinition): WorkflowSummary {
  return {
    workflowId: workflow.id,
    name: workflow.name,
    description: workflow.description,
    builtIn: workflow.builtIn,
    projectId: workflow.projectId,
  };
}

export function resolveWorkflowScopeLabel(input: {
  builtIn: boolean;
  projectId: ProjectId | null;
}): string {
  if (input.builtIn) {
    return "Built-in";
  }
  if (input.projectId !== null) {
    return "Project";
  }
  return "Global";
}

export function resolveWorkflowExecutionKind(
  phaseType: WorkflowPhase["type"],
): WorkflowExecutionKind {
  switch (phaseType) {
    case "automated":
      return "automated";
    case "human":
      return "human";
    case "single-agent":
    case "multi-agent":
      return "agent";
  }
}

export function setWorkflowPhaseExecutionKind(
  phase: WorkflowPhase,
  executionKind: WorkflowExecutionKind,
): WorkflowPhase {
  if (executionKind === "automated") {
    return normalizeWorkflowPhaseChecks({
      ...phase,
      type: "automated",
      sandboxMode: defaultSandboxMode("automated"),
      agent: undefined,
      deliberation: undefined,
      qualityChecks:
        phase.type === "automated"
          ? (phase.qualityChecks ?? [])
          : [createQualityCheckReference("test")],
      gate: {
        ...phase.gate,
        after: phase.gate.after === "done" ? "quality-checks" : phase.gate.after,
      },
    });
  }

  if (executionKind === "human") {
    return normalizeWorkflowPhaseChecks({
      ...phase,
      type: "human",
      sandboxMode: defaultSandboxMode("human"),
      agent: undefined,
      deliberation: undefined,
      qualityChecks: undefined,
      gate: {
        ...phase.gate,
        after: phase.gate.after === "quality-checks" ? "human-approval" : phase.gate.after,
      },
    });
  }

  if (phase.type === "single-agent" || phase.type === "multi-agent") {
    return phase;
  }

  return normalizeWorkflowPhaseChecks({
    ...phase,
    type: "single-agent",
    sandboxMode: defaultSandboxMode("single-agent"),
    agent: {
      prompt: "implement",
      output: { type: "conversation" },
    },
    deliberation: undefined,
    qualityChecks: undefined,
  });
}

export function setWorkflowPhaseDeliberation(
  phase: WorkflowPhase,
  enabled: boolean,
): WorkflowPhase {
  if (resolveWorkflowExecutionKind(phase.type) !== "agent") {
    return phase;
  }

  if (enabled) {
    const participants = phase.deliberation?.participants ?? [];
    return {
      ...phase,
      type: "multi-agent",
      sandboxMode: defaultSandboxMode("multi-agent"),
      agent: undefined,
      deliberation: {
        participants: [
          participants[0] ?? {
            role: "advocate",
            agent: {
              prompt: "advocate",
              output: { type: "channel" },
            },
          },
          participants[1] ?? {
            role: "interrogator",
            agent: {
              prompt: "interrogator",
              output: { type: "channel" },
            },
          },
        ],
        maxTurns: phase.deliberation?.maxTurns ?? 20,
      },
    };
  }

  return {
    ...phase,
    type: "single-agent",
    sandboxMode: defaultSandboxMode("single-agent"),
    deliberation: undefined,
    agent: phase.agent ?? {
      prompt: "implement",
      output: { type: "conversation" },
    },
  };
}

export function setWorkflowPhaseAfter(phase: WorkflowPhase, after: GateAfter): WorkflowPhase {
  return normalizeWorkflowPhaseChecks({
    ...phase,
    gate: {
      ...phase.gate,
      after,
      qualityChecks: after === "quality-checks" ? (phase.gate.qualityChecks ?? []) : undefined,
    },
  });
}

export function toggleWorkflowPhaseQualityCheck(
  phase: WorkflowPhase,
  check: string,
  enabled: boolean,
): WorkflowPhase {
  const sourceChecks =
    phase.type === "automated" ? (phase.qualityChecks ?? []) : (phase.gate.qualityChecks ?? []);
  const existing = sourceChecks.some((candidate) => candidate.check === check);
  const nextChecks = enabled
    ? existing
      ? sourceChecks
      : [...sourceChecks, createQualityCheckReference(check)]
    : sourceChecks.filter((candidate) => candidate.check !== check);

  return normalizeWorkflowPhaseChecks(
    phase.type === "automated"
      ? {
          ...phase,
          qualityChecks: nextChecks,
        }
      : {
          ...phase,
          gate: {
            ...phase.gate,
            qualityChecks: nextChecks,
          },
        },
  );
}

export function updateWorkflowDraftPhase(
  draft: WorkflowDefinition,
  phaseId: WorkflowPhase["id"],
  updater: (phase: WorkflowPhase, index: number) => WorkflowPhase,
): WorkflowDefinition {
  return {
    ...draft,
    phases: draft.phases.map((phase, index) =>
      phase.id === phaseId ? updater(phase, index) : phase,
    ),
  };
}

export function appendWorkflowDraftPhase(
  draft: WorkflowDefinition,
  input?: {
    type?: WorkflowPhase["type"];
  },
): WorkflowDefinition {
  const nextPhase = createDefaultWorkflowPhase({
    index: draft.phases.length,
    ...(input?.type ? { type: input.type } : {}),
  });
  const nextPhases = draft.phases.map((phase, index) =>
    index === draft.phases.length - 1 && phase.gate.after === "done"
      ? {
          ...phase,
          gate: {
            ...phase.gate,
            after: "auto-continue" as const,
          },
        }
      : phase,
  );

  return {
    ...draft,
    phases: normalizeWorkflowTerminalPhase([...nextPhases, nextPhase]),
  };
}

export function removeWorkflowDraftPhase(
  draft: WorkflowDefinition,
  phaseId: WorkflowPhase["id"],
): WorkflowDefinition {
  const nextPhases = draft.phases.filter((phase) => phase.id !== phaseId);
  if (nextPhases.length === 0) {
    return {
      ...draft,
      phases: [createDefaultWorkflowPhase()],
    };
  }

  return {
    ...draft,
    phases: normalizeWorkflowTerminalPhase(nextPhases),
  };
}

export function reorderWorkflowDraftPhases(
  draft: WorkflowDefinition,
  fromIndex: number,
  toIndex: number,
): WorkflowDefinition {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= draft.phases.length ||
    toIndex >= draft.phases.length ||
    fromIndex === toIndex
  ) {
    return draft;
  }

  const nextPhases = [...draft.phases];
  const [moved] = nextPhases.splice(fromIndex, 1);
  if (!moved) {
    return draft;
  }
  nextPhases.splice(toIndex, 0, moved);

  return {
    ...draft,
    phases: normalizeWorkflowTerminalPhase(nextPhases),
  };
}

export function resolveWorkflowMutationKind(input: {
  routeWorkflowId: WorkflowDefinition["id"] | null;
  sourceWorkflow: WorkflowDefinition | null;
  draft: WorkflowDefinition;
}): WorkflowMutationKind {
  if (
    input.routeWorkflowId !== null &&
    input.sourceWorkflow !== null &&
    !input.sourceWorkflow.builtIn &&
    input.sourceWorkflow.id === input.draft.id
  ) {
    return "update";
  }

  return "create";
}

export function buildWorkflowMutationDefinition(
  draft: WorkflowDefinition,
  updatedAt: string,
  projectId: ProjectId | null,
): WorkflowDefinition {
  return {
    ...draft,
    projectId,
    phases: draft.phases.map(normalizeWorkflowPhaseChecks),
    updatedAt,
  };
}

export function resolveWorkflowPromptOptions(input: {
  workflows: readonly WorkflowDefinition[];
  draft?: WorkflowDefinition | null;
}): string[] {
  const options = new Set<string>(DEFAULT_WORKFLOW_PROMPT_OPTIONS);

  const collect = (workflow: WorkflowDefinition) => {
    for (const phase of workflow.phases) {
      if (phase.agent?.prompt) {
        options.add(phase.agent.prompt);
      }

      for (const participant of phase.deliberation?.participants ?? []) {
        if (participant.agent.prompt) {
          options.add(participant.agent.prompt);
        }
      }
    }
  };

  for (const workflow of input.workflows) {
    collect(workflow);
  }

  if (input.draft) {
    collect(input.draft);
  }

  return [...options].toSorted((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
}

export function resolveWorkflowQualityCheckOptions(input: {
  workflows: readonly WorkflowDefinition[];
  draft?: WorkflowDefinition | null;
}): string[] {
  const options = new Set<string>(DEFAULT_WORKFLOW_CHECK_OPTIONS);

  const collect = (workflow: WorkflowDefinition) => {
    for (const phase of workflow.phases) {
      for (const check of phase.qualityChecks ?? []) {
        options.add(check.check);
      }
      for (const check of phase.gate.qualityChecks ?? []) {
        options.add(check.check);
      }
    }
  };

  for (const workflow of input.workflows) {
    collect(workflow);
  }

  if (input.draft) {
    collect(input.draft);
  }

  return [...options].toSorted((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
}

export function resolvePreviousPhaseOptions(
  phases: readonly WorkflowPhase[],
  currentPhaseId: WorkflowPhase["id"],
): string[] {
  const currentIndex = phases.findIndex((phase) => phase.id === currentPhaseId);
  if (currentIndex <= 0) {
    return [];
  }

  return phases.slice(0, currentIndex).map((phase) => phase.name);
}

export function resolvePromptEditorValue(prompt: string, promptOptions: readonly string[]): string {
  return promptOptions.includes(prompt) ? prompt : "__custom__";
}

export function resolveWorkflowScopeProjectId(
  scope: "global" | "project",
  availableProjectId: ProjectId | null,
): ProjectId | null {
  if (scope !== "project") {
    return null;
  }
  return availableProjectId;
}

export function resolveModelSelectionForEditor(
  selectedModel: ModelSelection | undefined,
  fallbackModel: ModelSelection,
): ModelSelection {
  return selectedModel ?? fallbackModel;
}
