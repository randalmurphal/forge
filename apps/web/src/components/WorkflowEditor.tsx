import type {
  ProjectId,
  WorkflowDefinition,
  WorkflowId,
  WorkflowPhase,
  WorkflowSummary,
} from "@forgetools/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { cn } from "~/lib/utils";
import { resolveAppModelSelectionState } from "../modelSelection";
import { useServerConfig } from "../rpc/serverState";
import { useStore } from "../store";
import {
  useWorkflow,
  useWorkflowStore,
  useWorkflows,
  workflowQueryKeys,
} from "../stores/workflowStore";
import { getWsRpcClient } from "../wsRpcClient";
import { useSettings } from "../hooks/useSettings";
import { toastManager } from "./ui/toast";
import { PhaseCard } from "./PhaseCard";
import { AgentModesPage } from "./AgentModesPage";
import {
  WorkflowEditorBasicsSection,
  WorkflowEditorFootnote,
  WorkflowEditorSidebar,
  WorkflowEditorTopBar,
} from "./WorkflowEditor.parts";
import {
  appendWorkflowDraftPhase,
  buildWorkflowMutationDefinition,
  cloneWorkflowForEditing,
  createEmptyWorkflowDefinition,
  removeWorkflowDraftPhase,
  reorderWorkflowDraftPhases,
  resolveWorkflowMutationKind,
  resolveWorkflowPromptOptions,
  resolveWorkflowQualityCheckOptions,
  resolvePreviousPhaseOptions,
  resolveWorkflowScopeLabel,
  resolveWorkflowScopeProjectId,
  sortWorkflowDefinitionsForEditor,
  toWorkflowSummaryRecord,
} from "./WorkflowEditor.logic";

/**
 * Phase type → color for the card top-bar stripe and active border accent.
 * Matches PhaseTypeBadge tone colors: sky (single), amber (multi), emerald (automated), violet (human).
 */
const PHASE_CARD_COLORS: Record<WorkflowPhase["type"], { stripeColor: string; label: string }> = {
  "single-agent": {
    stripeColor: "var(--feature-phase-single-agent)",
    label: "Single agent",
  },
  "multi-agent": {
    stripeColor: "var(--feature-phase-multi-agent)",
    label: "Deliberation",
  },
  automated: {
    stripeColor: "var(--feature-phase-automated)",
    label: "Automated",
  },
  human: {
    stripeColor: "var(--feature-phase-human)",
    label: "Human",
  },
};

function validateWorkflowDraft(draft: WorkflowDefinition | null): string | null {
  if (!draft) {
    return "Workflow draft is unavailable.";
  }
  if (draft.name.trim().length === 0) {
    return "Add a workflow name.";
  }

  for (const phase of draft.phases) {
    if (phase.name.trim().length === 0) {
      return "Each phase needs a name.";
    }
    if (phase.type === "single-agent" && (phase.agent?.prompt.trim().length ?? 0) === 0) {
      return `Add a prompt for '${phase.name}'.`;
    }
    if (phase.type === "multi-agent" && (phase.deliberation?.participants.length ?? 0) < 2) {
      return `Add both deliberation participants for '${phase.name}'.`;
    }
    if (
      phase.type === "multi-agent" &&
      phase.deliberation?.participants.some(
        (participant) => participant.agent.prompt.trim().length === 0,
      )
    ) {
      return `Each deliberation participant in '${phase.name}' needs a prompt.`;
    }
    if (phase.gate.onFail === "go-back-to" && !phase.gate.retryPhase) {
      return `Choose a retry target for '${phase.name}'.`;
    }
  }

  return null;
}

function mergeWorkflowIntoSummaries(
  summaries: readonly WorkflowSummary[],
  workflow: WorkflowDefinition,
): WorkflowSummary[] {
  const summary = toWorkflowSummaryRecord(workflow);
  const existingIndex = summaries.findIndex(
    (candidate) => candidate.workflowId === summary.workflowId,
  );
  if (existingIndex === -1) {
    return [...summaries, summary];
  }

  return summaries.map((candidate, index) => (index === existingIndex ? summary : candidate));
}

function PhaseStripCard(props: {
  phase: WorkflowPhase;
  phaseIndex: number;
  active: boolean;
  onClick: () => void;
}) {
  const colors = PHASE_CARD_COLORS[props.phase.type];
  const modelInfo =
    props.phase.type === "single-agent"
      ? props.phase.agent?.prompt
      : props.phase.type === "multi-agent"
        ? `${props.phase.deliberation?.participants.length ?? 0} participants`
        : null;

  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "relative min-w-0 flex-1 cursor-pointer overflow-hidden rounded-xl border bg-[var(--panel)] p-3.5 pt-4 text-left transition-all",
        props.active
          ? "bg-[var(--panel-elevated)]"
          : "border-border hover:bg-[var(--panel-elevated)]",
      )}
      style={
        props.active
          ? {
              borderColor: `color-mix(in srgb, ${colors.stripeColor} 30%, transparent)`,
              boxShadow: "var(--panel-shadow-active)",
            }
          : undefined
      }
    >
      {/* Color stripe at top */}
      <div
        className={cn("absolute inset-x-0 top-0 h-[2.5px] transition-opacity")}
        style={{
          backgroundColor: colors.stripeColor,
          opacity: props.active ? 1 : 0.7,
        }}
      />
      <div className="text-sm font-semibold text-foreground">
        {props.phase.name || `Phase ${props.phaseIndex + 1}`}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-muted-foreground/60">{colors.label}</div>
      {modelInfo ? (
        <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          {modelInfo}
        </span>
      ) : null}
    </button>
  );
}

function PhaseStripAddButton(props: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className="flex w-12 shrink-0 cursor-pointer items-center justify-center rounded-xl border-[1.5px] border-dashed border-border text-xl text-muted-foreground/60 transition-all hover:border-muted-foreground/60 hover:bg-[var(--panel)] hover:text-muted-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      +
    </button>
  );
}

export function WorkflowEditor(props: { workflowId: WorkflowId | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const serverConfig = useServerConfig();
  const settings = useSettings();
  const projects = useStore((store) => store.projects);
  const [selectedPhaseIndex, setSelectedPhaseIndex] = useState(0);
  const {
    cachedWorkflowSummaries,
    cachedWorkflowsById,
    draft,
    draftDirty,
    editingWorkflowId,
    projectId,
    resetEditingState,
    scope,
    setEditingDraft,
    setEditingMetadata,
    setEditingState,
  } = useWorkflowStore(
    useShallow((state) => ({
      cachedWorkflowSummaries: state.availableWorkflows,
      cachedWorkflowsById: state.workflowsById,
      draft: state.editingWorkflowDraft,
      draftDirty: state.editingDirty,
      editingWorkflowId: state.editingWorkflowId,
      projectId: state.editingProjectId,
      resetEditingState: state.resetEditingState,
      scope: state.editingScope,
      setEditingDraft: state.setEditingDraft,
      setEditingMetadata: state.setEditingMetadata,
      setEditingState: state.setEditingState,
    })),
  );
  const workflowListQuery = useWorkflows();
  const workflowDetailQuery = useWorkflow(props.workflowId);
  const sourceWorkflow =
    (props.workflowId
      ? (workflowDetailQuery.data ?? cachedWorkflowsById[props.workflowId] ?? null)
      : null) ?? null;
  const providers = serverConfig?.providers ?? [];
  const resolvedProjectId = resolveWorkflowScopeProjectId(scope, projectId);
  const currentProject = projects.find((project) => project.id === resolvedProjectId) ?? null;
  const fallbackModelSelection =
    currentProject?.defaultModelSelection ?? resolveAppModelSelectionState(settings, providers);
  const availableSummaries = workflowListQuery.data ?? cachedWorkflowSummaries;
  const promptOptions = resolveWorkflowPromptOptions({
    workflows: sourceWorkflow ? [sourceWorkflow] : [],
    draft,
  });
  const qualityCheckOptions = resolveWorkflowQualityCheckOptions({
    workflows: sourceWorkflow ? [sourceWorkflow] : [],
    draft,
  });
  const validationMessage = validateWorkflowDraft(draft);
  const isReadOnlyBuiltIn =
    props.workflowId !== null &&
    sourceWorkflow !== null &&
    sourceWorkflow.builtIn &&
    draft?.id === sourceWorkflow.id;
  const scopeLabel = draft
    ? resolveWorkflowScopeLabel({
        builtIn: sourceWorkflow?.builtIn ?? false,
        projectId: resolvedProjectId,
      })
    : "Global";

  // Reset selected phase when switching workflows
  useEffect(() => {
    setSelectedPhaseIndex(0);
  }, [props.workflowId]);

  useEffect(() => {
    if (props.workflowId === null) {
      if (editingWorkflowId === null && draft !== null) {
        return;
      }
      setEditingState({
        workflowId: null,
        draft: createEmptyWorkflowDefinition(new Date().toISOString()),
        scope: "global",
        projectId,
        dirty: false,
      });
      return;
    }

    if (!sourceWorkflow) {
      return;
    }

    if (editingWorkflowId === props.workflowId && draftDirty) {
      return;
    }

    setEditingState({
      workflowId: props.workflowId,
      draft: sourceWorkflow,
      scope: sourceWorkflow.projectId === null ? "global" : "project",
      projectId: sourceWorkflow.projectId,
      dirty: false,
    });
  }, [
    draft,
    draftDirty,
    editingWorkflowId,
    projectId,
    projects,
    props.workflowId,
    setEditingState,
    sourceWorkflow,
  ]);

  useEffect(() => {
    if (scope === "project" && projectId === null && projects[0]?.id) {
      setEditingMetadata({
        projectId: projects[0].id,
        dirty: draftDirty,
      });
    }
  }, [draftDirty, projectId, projects, scope, setEditingMetadata]);

  useEffect(() => () => resetEditingState(), [resetEditingState]);

  const updateDraft = (updater: (current: WorkflowDefinition) => WorkflowDefinition) => {
    if (!draft) {
      return;
    }

    setEditingDraft(updater(draft), { dirty: true });
  };

  const updateEditingScope = (nextScope: "global" | "project", nextProjectId: ProjectId | null) => {
    const normalizedProjectId = nextScope === "project" ? nextProjectId : null;
    setEditingMetadata({
      scope: nextScope,
      projectId: normalizedProjectId,
      dirty: draftDirty || scope !== nextScope || projectId !== normalizedProjectId,
    });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft) {
        throw new Error("Workflow draft is unavailable.");
      }

      const workflow = buildWorkflowMutationDefinition(
        draft,
        new Date().toISOString(),
        resolvedProjectId,
      );
      const kind = resolveWorkflowMutationKind({
        routeWorkflowId: props.workflowId,
        sourceWorkflow,
        draft: workflow,
      });

      const client = getWsRpcClient();
      const result =
        kind === "update"
          ? await client.workflow.update({ workflow })
          : await client.workflow.create({ workflow });

      return {
        kind,
        workflow: result.workflow,
      };
    },
    onSuccess: async ({ kind, workflow }) => {
      setEditingState({
        workflowId: workflow.id,
        draft: workflow,
        scope,
        projectId: resolvedProjectId,
        dirty: false,
      });
      queryClient.setQueryData(workflowQueryKeys.detail(workflow.id), workflow);
      queryClient.setQueryData(
        workflowQueryKeys.list(),
        (previous: readonly WorkflowSummary[] | undefined) =>
          mergeWorkflowIntoSummaries(previous ?? availableSummaries, workflow),
      );
      await queryClient.invalidateQueries({ queryKey: workflowQueryKeys.list() });

      toastManager.add({
        type: "success",
        title: kind === "update" ? "Workflow updated" : "Workflow created",
      });

      if (props.workflowId !== workflow.id) {
        await navigate({
          to: "/agent-modes/workflows/$workflowId",
          params: { workflowId: workflow.id },
        });
      }
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Unable to save workflow",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    },
  });

  const renderedDefinitions = sortWorkflowDefinitionsForEditor(
    availableSummaries.map((summary) => {
      const detailed = cachedWorkflowsById[summary.workflowId];
      return (
        detailed ?? {
          id: summary.workflowId,
          name: summary.name,
          description: summary.description,
          builtIn: summary.builtIn,
          projectId: summary.projectId,
          phases: [],
          createdAt: "",
          updatedAt: "",
        }
      );
    }),
  );

  // Clamp selected phase index to valid range
  const phaseCount = draft?.phases.length ?? 0;
  const clampedPhaseIndex = Math.max(0, Math.min(selectedPhaseIndex, phaseCount - 1));
  const selectedPhase = draft?.phases[clampedPhaseIndex] ?? null;

  if (props.workflowId !== null && workflowDetailQuery.isPending && !sourceWorkflow) {
    return (
      <AgentModesPage activeTab="workflows">
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading workflow…
        </div>
      </AgentModesPage>
    );
  }

  if (props.workflowId !== null && workflowDetailQuery.isError && !sourceWorkflow) {
    return (
      <AgentModesPage activeTab="workflows">
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {workflowDetailQuery.error instanceof Error
            ? workflowDetailQuery.error.message
            : "Unable to load this workflow."}
        </div>
      </AgentModesPage>
    );
  }

  return (
    <AgentModesPage activeTab="workflows">
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkflowEditorTopBar
          workflowName={draft?.name ?? ""}
          scopeLabel={scopeLabel}
          isExisting={
            props.workflowId !== null && sourceWorkflow !== null && !sourceWorkflow.builtIn
          }
          onCreateNew={() => void navigate({ to: "/agent-modes/workflows" })}
          onSave={() => void saveMutation.mutateAsync()}
          saveDisabled={saveMutation.isPending || validationMessage !== null || isReadOnlyBuiltIn}
          savePending={saveMutation.isPending}
        />
        <div className="grid min-h-0 flex-1 lg:grid-cols-[19rem_minmax(0,1fr)]">
          <WorkflowEditorSidebar
            workflows={renderedDefinitions}
            activeWorkflowId={props.workflowId}
            onCreateNew={() => void navigate({ to: "/agent-modes/workflows" })}
            onSelectWorkflow={(workflowId) =>
              void navigate({
                to: "/agent-modes/workflows/$workflowId",
                params: { workflowId },
              })
            }
          />

          <main className="min-h-0 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-5 py-7 sm:px-9">
              <WorkflowEditorBasicsSection
                draft={draft}
                disabled={!draft || isReadOnlyBuiltIn}
                scope={scope}
                projects={projects}
                currentProject={currentProject}
                draftDirty={draftDirty}
                sourceWorkflow={sourceWorkflow}
                validationMessage={validationMessage}
                onDraftNameChange={(name) =>
                  updateDraft((current) => ({
                    ...current,
                    name,
                  }))
                }
                onDraftDescriptionChange={(description) =>
                  updateDraft((current) => ({
                    ...current,
                    description,
                  }))
                }
                onScopeChange={(nextScope) =>
                  updateEditingScope(
                    nextScope,
                    nextScope === "project" ? (projectId ?? projects[0]?.id ?? null) : null,
                  )
                }
                onProjectScopeRequest={() =>
                  updateEditingScope("project", projectId ?? projects[0]?.id ?? null)
                }
                onCloneBuiltIn={() => {
                  if (!sourceWorkflow) {
                    return;
                  }
                  const clonedWorkflow = cloneWorkflowForEditing(
                    sourceWorkflow,
                    new Date().toISOString(),
                  );
                  setEditingState({
                    workflowId: props.workflowId,
                    draft: clonedWorkflow,
                    scope: clonedWorkflow.projectId === null ? "global" : "project",
                    projectId: clonedWorkflow.projectId,
                    dirty: true,
                  });
                }}
              />

              {/* Phases section */}
              <div>
                <div className="mb-3.5 flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/60">
                    Phases
                  </span>
                </div>

                {/* Phase strip: horizontal row of cards */}
                <div className="flex gap-2">
                  {draft?.phases.map((phase, phaseIndex) => (
                    <PhaseStripCard
                      key={phase.id}
                      phase={phase}
                      phaseIndex={phaseIndex}
                      active={clampedPhaseIndex === phaseIndex}
                      onClick={() => setSelectedPhaseIndex(phaseIndex)}
                    />
                  ))}
                  <PhaseStripAddButton
                    onClick={() => {
                      updateDraft((current) => appendWorkflowDraftPhase(current));
                      setSelectedPhaseIndex(phaseCount);
                    }}
                    disabled={!draft || isReadOnlyBuiltIn}
                  />
                </div>

                {/* Editor panel below with connector arrow */}
                {selectedPhase && draft ? (
                  <div className="relative mt-2">
                    {/* Connector nub */}
                    <div
                      className="absolute -top-1.5 z-10 size-3 rotate-45 border border-b-0 border-r-0 border-border bg-[var(--panel)] transition-[left] duration-200 ease-out"
                      style={{
                        left:
                          phaseCount <= 1
                            ? "60px"
                            : `calc(${((clampedPhaseIndex + 0.5) / (phaseCount + 0.6)) * 100}% - 6px)`,
                      }}
                    />
                    <div
                      className="rounded-xl border border-border bg-[var(--panel)] p-5"
                      style={{ boxShadow: "var(--panel-shadow)" }}
                    >
                      <PhaseCard
                        phase={selectedPhase}
                        phaseIndex={clampedPhaseIndex}
                        totalPhases={draft.phases.length}
                        promptOptions={promptOptions}
                        qualityCheckOptions={qualityCheckOptions}
                        settings={settings}
                        providers={providers}
                        fallbackModelSelection={fallbackModelSelection}
                        disabled={isReadOnlyBuiltIn}
                        previousPhaseOptions={resolvePreviousPhaseOptions(
                          draft.phases,
                          selectedPhase.id,
                        )}
                        onChange={(nextPhase) =>
                          updateDraft((current) => ({
                            ...current,
                            phases: current.phases.map((candidate) =>
                              candidate.id === nextPhase.id ? nextPhase : candidate,
                            ),
                          }))
                        }
                        onDelete={() => {
                          const removedIndex = clampedPhaseIndex;
                          updateDraft((current) =>
                            removeWorkflowDraftPhase(current, selectedPhase.id),
                          );
                          setSelectedPhaseIndex(Math.max(0, removedIndex - 1));
                        }}
                        onMoveUp={() =>
                          updateDraft((current) => {
                            const reordered = reorderWorkflowDraftPhases(
                              current,
                              clampedPhaseIndex,
                              clampedPhaseIndex - 1,
                            );
                            if (reordered !== current) {
                              setSelectedPhaseIndex(clampedPhaseIndex - 1);
                            }
                            return reordered;
                          })
                        }
                        onMoveDown={() =>
                          updateDraft((current) => {
                            const reordered = reorderWorkflowDraftPhases(
                              current,
                              clampedPhaseIndex,
                              clampedPhaseIndex + 1,
                            );
                            if (reordered !== current) {
                              setSelectedPhaseIndex(clampedPhaseIndex + 1);
                            }
                            return reordered;
                          })
                        }
                      />
                    </div>
                  </div>
                ) : null}
              </div>

              <WorkflowEditorFootnote />
            </div>
          </main>
        </div>
      </div>
    </AgentModesPage>
  );
}
