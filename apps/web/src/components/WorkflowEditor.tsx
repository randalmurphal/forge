import type {
  ProjectId,
  WorkflowDefinition,
  WorkflowId,
  WorkflowSummary,
} from "@forgetools/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link2Icon, PlusIcon, SaveIcon, SparklesIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "~/lib/utils";
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
import { Input } from "./ui/input";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { Textarea } from "./ui/textarea";
import { PhaseCard } from "./PhaseCard";
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

      const workflow = buildWorkflowMutationDefinition(draft, new Date().toISOString());
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
        <div className="flex min-h-0 flex-1 flex-col">
          <header className="border-b border-border px-3 py-2 sm:px-5">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <span className="text-sm font-medium text-foreground">Workflow editor</span>
            </div>
          </header>
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Loading workflow…
          </div>
        </div>
      </SidebarInset>
    );
  }

  if (props.workflowId !== null && workflowDetailQuery.isError && !sourceWorkflow) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <div className="flex min-h-0 flex-1 flex-col">
          <header className="border-b border-border px-3 py-2 sm:px-5">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <span className="text-sm font-medium text-foreground">Workflow editor</span>
            </div>
          </header>
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {workflowDetailQuery.error instanceof Error
              ? workflowDetailQuery.error.message
              : "Unable to load this workflow."}
          </div>
        </div>
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <header className="border-b border-border px-3 py-2 sm:px-5">
          <div className="flex flex-wrap items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">Workflow editor</p>
              <p className="text-xs text-muted-foreground">
                Build list-based workflows with phase gates, deliberation, and retry behavior.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void navigate({ to: "/workflow/editor" })}
            >
              <PlusIcon className="size-4" />
              New workflow
            </Button>
            <Button
              type="button"
              onClick={() => void saveMutation.mutateAsync()}
              disabled={saveMutation.isPending || validationMessage !== null || isReadOnlyBuiltIn}
            >
              <SaveIcon className="size-4" />
              {saveMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[19rem_minmax(0,1fr)]">
          <aside className="min-h-0 border-b border-border/70 bg-card/50 lg:border-r lg:border-b-0">
            <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Workflows
                </p>
                <p className="text-xs text-muted-foreground">Built-in first, then custom.</p>
              </div>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void navigate({ to: "/workflow/editor" })}
              >
                <PlusIcon className="size-3.5" />
                New
              </Button>
            </div>
            <div className="max-h-64 overflow-y-auto px-2 py-2 lg:max-h-none lg:h-full">
              <div className="space-y-1">
                {renderedDefinitions.map((workflow) => {
                  const active = props.workflowId === workflow.id;
                  return (
                    <Button
                      key={workflow.id}
                      type="button"
                      variant="ghost"
                      className={cn(
                        "h-auto w-full justify-start rounded-xl px-3 py-3 text-left",
                        active && "bg-accent text-foreground",
                      )}
                      onClick={() =>
                        void navigate({
                          to: "/workflow/editor/$workflowId",
                          params: { workflowId: workflow.id },
                        })
                      }
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{workflow.name}</span>
                          {workflow.builtIn ? (
                            <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-amber-700 dark:text-amber-300">
                              Built-in
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {workflow.description || "No description"}
                        </p>
                      </div>
                    </Button>
                  );
                })}
              </div>
            </div>
          </aside>

          <main className="min-h-0 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-5 sm:px-6">
              <section className="rounded-2xl border border-border/80 bg-card/90 shadow-sm">
                <div className="grid gap-5 border-b border-border/70 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        Name
                      </label>
                      <Input
                        value={draft?.name ?? ""}
                        onChange={(event) => {
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  name: event.target.value,
                                }
                              : current,
                          );
                          setDraftDirty(true);
                        }}
                        placeholder="build-with-review"
                        disabled={!draft || isReadOnlyBuiltIn}
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        Description
                      </label>
                      <Textarea
                        value={draft?.description ?? ""}
                        onChange={(event) => {
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  description: event.target.value,
                                }
                              : current,
                          );
                          setDraftDirty(true);
                        }}
                        placeholder="Describe what this workflow optimizes for."
                        className="min-h-24"
                        disabled={!draft || isReadOnlyBuiltIn}
                      />
                    </div>
                  </div>

                  <div className="space-y-4 rounded-2xl border border-border/70 bg-background/60 p-4">
                    <div className="space-y-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        Scope
                      </p>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant={scope === "global" ? "secondary" : "outline"}
                          onClick={() => setScope("global")}
                          disabled={isReadOnlyBuiltIn}
                        >
                          Global
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={scope === "project" ? "secondary" : "outline"}
                          onClick={() => {
                            setScope("project");
                            if (!projectId && projects[0]?.id) {
                              setProjectId(projects[0].id);
                            }
                          }}
                          disabled={isReadOnlyBuiltIn || projects.length === 0}
                        >
                          This project
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {scope === "project"
                          ? currentProject
                            ? `Selected project: ${currentProject.name}`
                            : "No project is available yet."
                          : "Available across every project."}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        Status
                      </p>
                      <div className="rounded-xl border border-border/70 bg-card px-3 py-2 text-sm">
                        {draftDirty ? "Unsaved changes" : "Saved"}
                      </div>
                    </div>

                    {isReadOnlyBuiltIn ? (
                      <div className="space-y-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-3">
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-foreground">Built-in workflow</p>
                          <p className="text-xs text-muted-foreground">
                            Clone it before editing so the shipped template stays read-only.
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            if (!sourceWorkflow) {
                              return;
                            }
                            setDraft(
                              cloneWorkflowForEditing(sourceWorkflow, new Date().toISOString()),
                            );
                            setDraftDirty(true);
                          }}
                        >
                          <SparklesIcon className="size-4" />
                          Clone to edit
                        </Button>
                      </div>
                    ) : null}

                    {validationMessage ? (
                      <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                        {validationMessage}
                      </div>
                    ) : null}
                  </div>
                </div>

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

              <section className="rounded-2xl border border-border/70 bg-card/70 px-4 py-4 text-sm text-muted-foreground shadow-sm sm:px-5">
                <div className="flex items-start gap-3">
                  <Link2Icon className="mt-0.5 size-4 shrink-0" />
                  <p>
                    Built-in workflows stay read-only. Clone them to customize, then save as a new
                    workflow. The project scope toggle is preserved in editor state so the UI is
                    ready for project-backed workflow persistence as the backend catches up.
                  </p>
                </div>
              </section>
            </div>
          </main>
        </div>
      </div>
    </SidebarInset>
  );
}
