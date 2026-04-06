import type {
  ProjectId,
  WorkflowDefinition,
  WorkflowId,
  WorkflowSummary,
} from "@forgetools/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { resolveAppModelSelectionState } from "../modelSelection";
import { useServerConfig } from "../rpc/serverState";
import { useStore } from "../store";
import {
  type WorkflowEditScope,
  useWorkflow,
  useWorkflowStore,
  useWorkflows,
  workflowQueryKeys,
} from "../stores/workflowStore";
import { getWsRpcClient } from "../wsRpcClient";
import { useSettings } from "../hooks/useSettings";
import { toastManager } from "./ui/toast";
import { Button } from "./ui/button";
import { SidebarInset } from "./ui/sidebar";
import { PhaseCard } from "./PhaseCard";
import {
  WorkflowEditorBasicsSection,
  WorkflowEditorFootnote,
  WorkflowEditorShell,
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
  resolveWorkflowScopeProjectId,
  sortWorkflowDefinitionsForEditor,
  toWorkflowSummaryRecord,
} from "./WorkflowEditor.logic";

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

export function WorkflowEditor(props: { workflowId: WorkflowId | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const serverConfig = useServerConfig();
  const settings = useSettings();
  const projects = useStore((store) => store.projects);
  const setEditingState = useWorkflowStore((state) => state.setEditingState);
  const resetEditingState = useWorkflowStore((state) => state.resetEditingState);
  const cachedWorkflowsById = useWorkflowStore((state) => state.workflowsById);
  const cachedWorkflowSummaries = useWorkflowStore((state) => state.availableWorkflows);
  const workflowListQuery = useWorkflows();
  const workflowDetailQuery = useWorkflow(props.workflowId);
  const initialDraftRef = useRef(createEmptyWorkflowDefinition(new Date().toISOString()));
  const sourceWorkflow =
    (props.workflowId
      ? (workflowDetailQuery.data ?? cachedWorkflowsById[props.workflowId] ?? null)
      : null) ?? null;
  const [draft, setDraft] = useState<WorkflowDefinition | null>(
    props.workflowId ? null : initialDraftRef.current,
  );
  const [draftDirty, setDraftDirty] = useState(false);
  const [scope, setScope] = useState<WorkflowEditScope>("global");
  const [projectId, setProjectId] = useState<ProjectId | null>(projects[0]?.id ?? null);
  const providers = serverConfig?.providers ?? [];
  const resolvedProjectId = resolveWorkflowScopeProjectId(scope, projectId);
  const currentProject =
    projects.find((project) => project.id === resolvedProjectId) ?? projects[0] ?? null;
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

  useEffect(() => {
    if (!props.workflowId || !sourceWorkflow) {
      return;
    }
    setDraft(sourceWorkflow);
    setScope(sourceWorkflow.projectId === null ? "global" : "project");
    setProjectId(sourceWorkflow.projectId);
    setDraftDirty(false);
  }, [props.workflowId, sourceWorkflow]);

  useEffect(() => {
    if (scope === "project" && projectId === null && projects[0]?.id) {
      setProjectId(projects[0].id);
    }
  }, [projectId, projects, scope]);

  useEffect(() => {
    setEditingState({
      workflowId: props.workflowId,
      draft,
      scope,
      projectId: resolvedProjectId,
      dirty: draftDirty,
    });
  }, [draft, draftDirty, projectId, props.workflowId, resolvedProjectId, scope, setEditingState]);

  useEffect(() => () => resetEditingState(), [resetEditingState]);

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
      setDraft(workflow);
      setDraftDirty(false);
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
          to: "/workflow/editor/$workflowId",
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

  if (props.workflowId !== null && workflowDetailQuery.isPending && !sourceWorkflow) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <WorkflowEditorShell>
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Loading workflow…
          </div>
        </WorkflowEditorShell>
      </SidebarInset>
    );
  }

  if (props.workflowId !== null && workflowDetailQuery.isError && !sourceWorkflow) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <WorkflowEditorShell>
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {workflowDetailQuery.error instanceof Error
              ? workflowDetailQuery.error.message
              : "Unable to load this workflow."}
          </div>
        </WorkflowEditorShell>
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <WorkflowEditorTopBar
          onCreateNew={() => void navigate({ to: "/workflow/editor" })}
          onSave={() => void saveMutation.mutateAsync()}
          saveDisabled={saveMutation.isPending || validationMessage !== null || isReadOnlyBuiltIn}
          savePending={saveMutation.isPending}
        />
        <div className="grid min-h-0 flex-1 lg:grid-cols-[19rem_minmax(0,1fr)]">
          <WorkflowEditorSidebar
            workflows={renderedDefinitions}
            activeWorkflowId={props.workflowId}
            onCreateNew={() => void navigate({ to: "/workflow/editor" })}
            onSelectWorkflow={(workflowId) =>
              void navigate({
                to: "/workflow/editor/$workflowId",
                params: { workflowId },
              })
            }
          />

          <main className="min-h-0 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-5 sm:px-6">
              <WorkflowEditorBasicsSection
                draft={draft}
                disabled={!draft || isReadOnlyBuiltIn}
                scope={scope}
                projects={projects}
                currentProject={currentProject}
                draftDirty={draftDirty}
                sourceWorkflow={sourceWorkflow}
                validationMessage={validationMessage}
                onDraftNameChange={(name) => {
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          name,
                        }
                      : current,
                  );
                  setDraftDirty(true);
                }}
                onDraftDescriptionChange={(description) => {
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          description,
                        }
                      : current,
                  );
                  setDraftDirty(true);
                }}
                onScopeChange={setScope}
                onProjectScopeRequest={() => {
                  setScope("project");
                  if (!projectId && projects[0]?.id) {
                    setProjectId(projects[0].id);
                  }
                }}
                onCloneBuiltIn={() => {
                  if (!sourceWorkflow) {
                    return;
                  }
                  setDraft(cloneWorkflowForEditing(sourceWorkflow, new Date().toISOString()));
                  setDraftDirty(true);
                }}
              />

              <section className="rounded-2xl border border-border/80 bg-card/90 shadow-sm">
                <div className="border-b border-border/70 px-4 py-3 sm:px-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        Phases
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Keep the workflow list-based: one phase per card.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setDraft((current) =>
                          current ? appendWorkflowDraftPhase(current) : current,
                        );
                        setDraftDirty(true);
                      }}
                      disabled={!draft || isReadOnlyBuiltIn}
                    >
                      <PlusIcon className="size-4" />
                      Add phase
                    </Button>
                  </div>
                </div>

                <div className="space-y-4 px-4 py-4 sm:px-5">
                  {draft?.phases.map((phase, phaseIndex) => (
                    <PhaseCard
                      key={phase.id}
                      phase={phase}
                      phaseIndex={phaseIndex}
                      totalPhases={draft.phases.length}
                      promptOptions={promptOptions}
                      qualityCheckOptions={qualityCheckOptions}
                      settings={settings}
                      providers={providers}
                      fallbackModelSelection={fallbackModelSelection}
                      disabled={isReadOnlyBuiltIn}
                      previousPhaseOptions={resolvePreviousPhaseOptions(draft.phases, phase.id)}
                      onChange={(nextPhase) => {
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                phases: current.phases.map((candidate) =>
                                  candidate.id === nextPhase.id ? nextPhase : candidate,
                                ),
                              }
                            : current,
                        );
                        setDraftDirty(true);
                      }}
                      onDelete={() => {
                        setDraft((current) =>
                          current ? removeWorkflowDraftPhase(current, phase.id) : current,
                        );
                        setDraftDirty(true);
                      }}
                      onMoveUp={() => {
                        setDraft((current) =>
                          current
                            ? reorderWorkflowDraftPhases(current, phaseIndex, phaseIndex - 1)
                            : current,
                        );
                        setDraftDirty(true);
                      }}
                      onMoveDown={() => {
                        setDraft((current) =>
                          current
                            ? reorderWorkflowDraftPhases(current, phaseIndex, phaseIndex + 1)
                            : current,
                        );
                        setDraftDirty(true);
                      }}
                    />
                  ))}
                </div>
              </section>

              <WorkflowEditorFootnote />
            </div>
          </main>
        </div>
      </div>
    </SidebarInset>
  );
}
