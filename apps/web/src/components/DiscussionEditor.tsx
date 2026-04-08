import type {
  DiscussionDefinition,
  DiscussionParticipant,
  DiscussionScope,
  ModelSelection,
  ProjectId,
  ProviderKind,
} from "@forgetools/contracts";
import { PROVIDER_DISPLAY_NAMES } from "@forgetools/contracts";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { MessagesSquareIcon, PlusIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { getCustomModelOptionsByProvider, resolveAppModelSelectionState } from "../modelSelection";
import { useServerConfig } from "../rpc/serverState";
import { useStore } from "../store";
import {
  ALL_PROJECTS_DISCUSSION_FILTER,
  discussionQueryKeys,
  discussionManagedListQueryOptions,
  useDiscussionStore,
  useManagedDiscussion,
} from "../stores/discussionStore";
import { useUiStateStore } from "../uiStateStore";
import { getWsRpcClient } from "../wsRpcClient";
import { useSettings } from "../hooks/useSettings";
import {
  ensureDiscussionHasExplicitParticipantModels,
  sortManagedDiscussionsForEditor,
  validateDiscussionDraft,
  createEmptyDiscussionDefinition,
} from "./DiscussionEditor.logic";
import { AgentModesPage } from "./AgentModesPage";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "./ui/select";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";
import { cn } from "~/lib/utils";

const ALL_PROJECTS_VALUE = ALL_PROJECTS_DISCUSSION_FILTER;

type RenderedDiscussionSummary = {
  description: string;
  effective: boolean;
  name: string;
  ownerProjectId: ProjectId | null;
  ownerProjectName: string | null;
  participantRoles: readonly string[];
  scope: DiscussionScope;
};

function discussionRouteKey(input: {
  discussionName: string | null;
  discussionScope: DiscussionScope | null;
  projectId: ProjectId | null;
}) {
  return `${input.discussionScope ?? "new"}:${input.projectId ?? "global"}:${input.discussionName ?? "new"}`;
}

function stripScope(discussion: {
  name: string;
  description: string;
  participants: ReadonlyArray<DiscussionParticipant>;
  settings: DiscussionDefinition["settings"];
}) {
  return {
    name: discussion.name,
    description: discussion.description,
    participants: [...discussion.participants],
    settings: discussion.settings,
  } satisfies DiscussionDefinition;
}

function cloneModelSelection(selection: ModelSelection): ModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}

function createParticipant(index: number, modelSelection: ModelSelection): DiscussionParticipant {
  return {
    role: `participant-${index + 1}`,
    description: "",
    system: "",
    model: cloneModelSelection(modelSelection),
  };
}

function sortProjectsForEditor<TProject extends { id: ProjectId }>(
  projects: readonly TProject[],
  preferredIds: readonly ProjectId[],
): TProject[] {
  const orderById = new Map(preferredIds.map((projectId, index) => [projectId, index] as const));
  return [...projects].toSorted((left, right) => {
    const leftIndex = orderById.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = orderById.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
    return 0;
  });
}

function sortRenderedDiscussions(input: readonly RenderedDiscussionSummary[]) {
  return [...input].toSorted((left, right) => {
    if (left.scope !== right.scope) {
      return left.scope === "project" ? -1 : 1;
    }

    const projectNameComparison = (left.ownerProjectName ?? "").localeCompare(
      right.ownerProjectName ?? "",
      undefined,
      { sensitivity: "base" },
    );
    if (projectNameComparison !== 0) {
      return projectNameComparison;
    }

    if (left.effective !== right.effective) {
      return left.effective ? -1 : 1;
    }

    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

function navigateToDiscussionDetail(input: {
  discussionName: string;
  scope: DiscussionScope;
  navigate: ReturnType<typeof useNavigate>;
  projectId: ProjectId | null;
}) {
  if (input.scope === "global") {
    return input.navigate({
      to: "/agent-modes/discussions/global/$discussionName",
      params: { discussionName: input.discussionName },
    });
  }

  if (!input.projectId) {
    throw new Error("A project-scoped discussion requires a selected project.");
  }

  return input.navigate({
    to: "/agent-modes/discussions/project/$projectId/$discussionName",
    params: {
      projectId: input.projectId,
      discussionName: input.discussionName,
    },
  });
}

export function DiscussionEditor(props: {
  discussionName: string | null;
  discussionScope: DiscussionScope | null;
  projectId: ProjectId | null;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const settings = useSettings();
  const serverConfig = useServerConfig();
  const projects = useStore((store) => store.projects);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const managedProjectFilter = useDiscussionStore((store) => store.managedProjectFilter);
  const setManagedProjectFilter = useDiscussionStore((store) => store.setManagedProjectFilter);
  const [draft, setDraft] = useState<DiscussionDefinition | null>(null);
  const [editorScope, setEditorScope] = useState<DiscussionScope>("global");
  const [draftDirty, setDraftDirty] = useState(false);
  const [loadedRouteKey, setLoadedRouteKey] = useState<string | null>(null);
  const orderedProjects = useMemo(
    () => sortProjectsForEditor(projects, projectOrder),
    [projectOrder, projects],
  );
  const routeProject =
    orderedProjects.find((project) => project.id === props.projectId) ??
    projects.find((project) => project.id === props.projectId) ??
    null;
  const filterProjectId = managedProjectFilter === ALL_PROJECTS_VALUE ? null : managedProjectFilter;
  const filterProject =
    orderedProjects.find((project) => project.id === filterProjectId) ??
    projects.find((project) => project.id === filterProjectId) ??
    null;
  const targetProject =
    props.discussionScope === "project" && routeProject
      ? routeProject
      : editorScope === "project"
        ? filterProject
        : null;

  useEffect(() => {
    if (props.projectId !== null) {
      setManagedProjectFilter(props.projectId);
      return;
    }
    if (
      managedProjectFilter !== ALL_PROJECTS_VALUE &&
      !orderedProjects.some((project) => project.id === managedProjectFilter)
    ) {
      setManagedProjectFilter(ALL_PROJECTS_VALUE);
    }
  }, [managedProjectFilter, orderedProjects, props.projectId, setManagedProjectFilter]);

  const routeKey = discussionRouteKey(props);
  const providers = serverConfig?.providers ?? [];
  const fallbackModelSelection =
    targetProject?.defaultModelSelection ??
    routeProject?.defaultModelSelection ??
    resolveAppModelSelectionState(settings, providers);
  const availableProviders = (
    providers
      .filter((provider) => provider.enabled)
      .map((provider) => provider.provider) as ProviderKind[]
  ).filter((provider, index, items) => items.indexOf(provider) === index);
  const selectableProviders =
    availableProviders.length > 0 ? availableProviders : [fallbackModelSelection.provider];
  const modelOptionsByProvider = getCustomModelOptionsByProvider(settings, providers);
  const globalDiscussionsQuery = useQuery(discussionManagedListQueryOptions());
  const selectedProjectDiscussionsQuery = useQuery({
    ...discussionManagedListQueryOptions(filterProject?.cwd),
    enabled: filterProject !== null,
  });
  const allProjectDiscussionQueries = useQueries({
    queries: orderedProjects.map((project) => ({
      ...discussionManagedListQueryOptions(project.cwd),
      enabled: managedProjectFilter === ALL_PROJECTS_VALUE,
    })),
  });
  const renderedDiscussions = useMemo(() => {
    const globalDiscussions = (globalDiscussionsQuery.data ?? []).map((discussion) =>
      Object.assign({}, discussion, {
        ownerProjectId: null,
        ownerProjectName: null,
      }),
    );

    if (managedProjectFilter === ALL_PROJECTS_VALUE) {
      const projectDiscussions = orderedProjects.flatMap((project, index) =>
        (allProjectDiscussionQueries[index]?.data ?? [])
          .filter((discussion) => discussion.scope === "project")
          .map((discussion) =>
            Object.assign({}, discussion, {
              ownerProjectId: project.id,
              ownerProjectName: project.name,
            }),
          ),
      );

      return sortRenderedDiscussions([...globalDiscussions, ...projectDiscussions]);
    }

    const selectedProjectDiscussions = sortManagedDiscussionsForEditor(
      selectedProjectDiscussionsQuery.data ?? globalDiscussionsQuery.data ?? [],
    ).map((discussion) =>
      Object.assign({}, discussion, {
        ownerProjectId: discussion.scope === "project" ? (filterProject?.id ?? null) : null,
        ownerProjectName: discussion.scope === "project" ? (filterProject?.name ?? null) : null,
      }),
    );

    return sortRenderedDiscussions(selectedProjectDiscussions);
  }, [
    allProjectDiscussionQueries,
    filterProject?.id,
    filterProject?.name,
    globalDiscussionsQuery.data,
    managedProjectFilter,
    orderedProjects,
    selectedProjectDiscussionsQuery.data,
  ]);
  const managedDiscussionQuery = useManagedDiscussion({
    scope: props.discussionScope,
    name: props.discussionName,
    ...(props.discussionScope === "project" && routeProject?.cwd
      ? { workspaceRoot: routeProject.cwd }
      : {}),
  });
  const sourceDiscussion = managedDiscussionQuery.data ?? null;

  useEffect(() => {
    if (props.discussionName === null || props.discussionScope === null) {
      if (loadedRouteKey === routeKey && draft !== null) {
        return;
      }
      setDraft(createEmptyDiscussionDefinition(fallbackModelSelection));
      setEditorScope("global");
      setDraftDirty(false);
      setLoadedRouteKey(routeKey);
      return;
    }

    if (!sourceDiscussion) {
      return;
    }

    if (loadedRouteKey === routeKey && draftDirty) {
      return;
    }

    setDraft(
      ensureDiscussionHasExplicitParticipantModels(
        stripScope(sourceDiscussion),
        fallbackModelSelection,
      ),
    );
    setEditorScope(sourceDiscussion.scope);
    setDraftDirty(false);
    setLoadedRouteKey(routeKey);
  }, [
    fallbackModelSelection,
    draft,
    draftDirty,
    loadedRouteKey,
    props.discussionName,
    props.discussionScope,
    routeKey,
    sourceDiscussion,
  ]);

  const validationMessage = validateDiscussionDraft({
    draft,
    scope: editorScope,
    selectedProjectId: targetProject?.id ?? null,
    existingDiscussions: renderedDiscussions,
    routeDiscussionName: props.discussionName,
    routeScope: props.discussionScope,
  });

  const updateDraft = (updater: (current: DiscussionDefinition) => DiscussionDefinition) => {
    if (!draft) {
      return;
    }

    setDraft(updater(draft));
    setDraftDirty(true);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft) {
        throw new Error("Discussion draft is unavailable.");
      }

      const workspaceRoot =
        props.discussionScope === "project"
          ? routeProject?.cwd
          : editorScope === "project"
            ? targetProject?.cwd
            : undefined;
      if (editorScope === "project" && !workspaceRoot) {
        throw new Error("Choose a project before saving a project-scoped discussion.");
      }

      const client = getWsRpcClient();
      if (props.discussionName !== null && props.discussionScope !== null) {
        return (
          await client.discussion.update({
            previousName: props.discussionName,
            previousScope: props.discussionScope,
            discussion: draft,
            scope: editorScope,
            ...(workspaceRoot ? { workspaceRoot } : {}),
          })
        ).discussion;
      }

      return (
        await client.discussion.create({
          discussion: draft,
          scope: editorScope,
          ...(workspaceRoot ? { workspaceRoot } : {}),
        })
      ).discussion;
    },
    onSuccess: async (discussion) => {
      await queryClient.invalidateQueries({ queryKey: discussionQueryKeys.all });
      setDraft(stripScope(discussion));
      setEditorScope(discussion.scope);
      setDraftDirty(false);

      toastManager.add({
        type: "success",
        title:
          props.discussionName !== null && props.discussionScope !== null
            ? "Discussion updated"
            : "Discussion created",
      });

      await navigateToDiscussionDetail({
        discussionName: discussion.name,
        scope: discussion.scope,
        navigate,
        projectId: targetProject?.id ?? null,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Unable to save discussion",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (props.discussionName === null || props.discussionScope === null) {
        return;
      }
      const workspaceRootForDelete =
        props.discussionScope === "project" ? routeProject?.cwd : undefined;
      await getWsRpcClient().discussion.delete({
        name: props.discussionName,
        scope: props.discussionScope,
        ...(workspaceRootForDelete ? { workspaceRoot: workspaceRootForDelete } : {}),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: discussionQueryKeys.all });
      toastManager.add({
        type: "success",
        title: "Discussion deleted",
      });
      await navigate({ to: "/agent-modes/discussions" });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Unable to delete discussion",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    },
  });

  const scopeProjectLabel =
    props.discussionScope === "project" && routeProject
      ? routeProject.name
      : (targetProject?.name ?? "Choose a project");

  if (
    props.discussionName !== null &&
    props.discussionScope !== null &&
    managedDiscussionQuery.isPending &&
    !sourceDiscussion
  ) {
    return (
      <AgentModesPage activeTab="discussions">
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading discussion…
        </div>
      </AgentModesPage>
    );
  }

  if (
    props.discussionName !== null &&
    props.discussionScope !== null &&
    managedDiscussionQuery.isError &&
    !sourceDiscussion
  ) {
    return (
      <AgentModesPage activeTab="discussions">
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {managedDiscussionQuery.error instanceof Error
            ? managedDiscussionQuery.error.message
            : "Unable to load this discussion."}
        </div>
      </AgentModesPage>
    );
  }

  return (
    <AgentModesPage activeTab="discussions">
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="border-b border-border px-3 py-2 sm:px-5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">Discussions</p>
              <p className="text-xs text-muted-foreground">
                Configure participants, scope, and models for multi-agent discussions.
              </p>
            </div>
            {props.discussionName !== null && props.discussionScope !== null ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void deleteMutation.mutateAsync()}
                disabled={deleteMutation.isPending}
              >
                <Trash2Icon className="size-4" />
                Delete
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              onClick={() => void navigate({ to: "/agent-modes/discussions" })}
            >
              <PlusIcon className="size-4" />
              New discussion
            </Button>
            <Button
              type="button"
              onClick={() => void saveMutation.mutateAsync()}
              disabled={saveMutation.isPending || validationMessage !== null}
            >
              <SaveIcon className="size-4" />
              {saveMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[19rem_minmax(0,1fr)]">
          <aside className="min-h-0 border-b border-border/70 bg-card/50 lg:border-r lg:border-b-0">
            <div className="space-y-3 border-b border-border/70 px-4 py-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Discussions
                </p>
                <p className="text-xs text-muted-foreground">
                  Global plus the selected project, or every project at once.
                </p>
              </div>

              {orderedProjects.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Project context
                  </p>
                  <Select
                    value={managedProjectFilter as string}
                    onValueChange={(value) =>
                      setManagedProjectFilter(
                        value === ALL_PROJECTS_VALUE ? ALL_PROJECTS_VALUE : (value as ProjectId),
                      )
                    }
                  >
                    <SelectTrigger>
                      {managedProjectFilter === ALL_PROJECTS_VALUE
                        ? "All projects"
                        : (filterProject?.name ?? "Choose a project")}
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value={ALL_PROJECTS_VALUE}>All projects</SelectItem>
                      {orderedProjects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}
            </div>

            <div className="max-h-64 overflow-y-auto px-2 py-2 lg:h-full lg:max-h-none">
              {renderedDiscussions.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/70 px-3 py-4 text-xs text-muted-foreground">
                  No discussions yet.
                </div>
              ) : (
                <div className="space-y-1">
                  {renderedDiscussions.map((discussion) => {
                    const active =
                      props.discussionName === discussion.name &&
                      props.discussionScope === discussion.scope &&
                      (discussion.scope !== "project" ||
                        props.projectId === discussion.ownerProjectId);
                    return (
                      <Button
                        key={`${discussion.scope}:${discussion.ownerProjectId ?? "global"}:${discussion.name}`}
                        type="button"
                        variant="ghost"
                        className={cn(
                          "h-auto w-full justify-start rounded-xl px-3 py-3 text-left",
                          active && "bg-accent text-foreground",
                        )}
                        onClick={() =>
                          void navigateToDiscussionDetail({
                            discussionName: discussion.name,
                            scope: discussion.scope,
                            navigate,
                            projectId:
                              discussion.scope === "project" ? discussion.ownerProjectId : null,
                          })
                        }
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate font-medium">{discussion.name}</span>
                            <span className="rounded-full border border-border/70 bg-background px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                              {discussion.scope === "global"
                                ? "Global"
                                : (discussion.ownerProjectName ?? "Project")}
                            </span>
                            {!discussion.effective ? (
                              <span className="rounded-full border border-border/70 bg-background px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                                Shadowed
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                            {discussion.description || "No description"}
                          </p>
                        </div>
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>

          <main className="min-h-0 overflow-y-auto">
            {!draft ? (
              <Empty className="min-h-full">
                <EmptyMedia variant="icon">
                  <MessagesSquareIcon className="size-4" />
                </EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>Discussion editor unavailable</EmptyTitle>
                  <EmptyDescription>
                    The selected discussion could not be loaded into an editable draft.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-5 sm:px-6">
                <section className="rounded-2xl border border-border/80 bg-card/90 shadow-sm">
                  <div className="grid gap-5 border-b border-border/70 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                          Name
                        </label>
                        <Input
                          value={draft.name}
                          onChange={(event) =>
                            updateDraft((current) => ({
                              ...current,
                              name: event.target.value,
                            }))
                          }
                          placeholder="debate"
                        />
                      </div>

                      <div className="space-y-2">
                        <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                          Description
                        </label>
                        <Textarea
                          value={draft.description}
                          onChange={(event) =>
                            updateDraft((current) => ({
                              ...current,
                              description: event.target.value,
                            }))
                          }
                          placeholder="Describe what this discussion mode is for."
                          className="[&_textarea]:min-h-13"
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
                            variant={editorScope === "global" ? "default" : "outline"}
                            onClick={() => {
                              setEditorScope("global");
                              setDraftDirty(true);
                            }}
                          >
                            Global
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant={editorScope === "project" ? "default" : "outline"}
                            onClick={() => {
                              setEditorScope("project");
                              setDraftDirty(true);
                            }}
                            disabled={orderedProjects.length === 0}
                          >
                            This project
                          </Button>
                        </div>
                        {editorScope === "project" ? (
                          <p className="text-xs text-muted-foreground">{scopeProjectLabel}</p>
                        ) : null}
                      </div>

                      {validationMessage ? (
                        <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                          {validationMessage}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </section>

                <section className="rounded-2xl border border-border/80 bg-card/90 shadow-sm">
                  <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3 sm:px-5">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        Participants
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Define each role, model selection, and system prompt.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        updateDraft((current) => ({
                          ...current,
                          participants: [
                            ...current.participants,
                            createParticipant(current.participants.length, fallbackModelSelection),
                          ],
                        }))
                      }
                    >
                      <PlusIcon className="size-4" />
                      Add participant
                    </Button>
                  </div>

                  <div className="space-y-4 px-4 py-4 sm:px-5">
                    {draft.participants.map((participant, index) => (
                      <DiscussionParticipantCard
                        key={participant.role}
                        participant={participant}
                        index={index}
                        totalParticipants={draft.participants.length}
                        availableProviders={selectableProviders}
                        fallbackModelSelection={fallbackModelSelection}
                        modelOptionsByProvider={modelOptionsByProvider}
                        onChange={(nextParticipant) =>
                          updateDraft((current) => ({
                            ...current,
                            participants: current.participants.map((candidate, candidateIndex) =>
                              candidateIndex === index ? nextParticipant : candidate,
                            ),
                          }))
                        }
                        onDelete={() =>
                          updateDraft((current) => ({
                            ...current,
                            participants: current.participants.filter(
                              (_, candidateIndex) => candidateIndex !== index,
                            ),
                          }))
                        }
                      />
                    ))}
                  </div>
                </section>

                <section className="rounded-2xl border border-border/80 bg-card/90 shadow-sm">
                  <div className="border-b border-border/70 px-4 py-3 sm:px-5">
                    <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Settings
                    </p>
                  </div>
                  <div className="grid gap-4 px-4 py-4 sm:px-5 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        Max turns
                      </label>
                      <Input
                        type="number"
                        min={1}
                        nativeInput
                        value={draft.settings.maxTurns}
                        onChange={(event) =>
                          updateDraft((current) => ({
                            ...current,
                            settings: {
                              ...current.settings,
                              maxTurns: Number.parseInt(event.target.value || "0", 10),
                            },
                          }))
                        }
                      />
                    </div>
                  </div>
                </section>
              </div>
            )}
          </main>
        </div>
      </div>
    </AgentModesPage>
  );
}

function DiscussionParticipantCard(props: {
  participant: DiscussionParticipant;
  index: number;
  totalParticipants: number;
  availableProviders: readonly ProviderKind[];
  fallbackModelSelection: ModelSelection;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  onChange: (participant: DiscussionParticipant) => void;
  onDelete: () => void;
}) {
  const activeProvider = props.participant.model?.provider ?? props.fallbackModelSelection.provider;
  const activeModel = props.participant.model?.model ?? props.fallbackModelSelection.model;

  return (
    <section className="rounded-2xl border border-border/70 bg-background/60 p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">Participant {props.index + 1}</p>
          <p className="text-xs text-muted-foreground">
            Role, description, model, and system prompt.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={props.onDelete}
          disabled={props.totalParticipants <= 2}
        >
          <Trash2Icon className="size-4" />
          Remove
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Role
          </label>
          <Input
            value={props.participant.role}
            onChange={(event) =>
              props.onChange({
                ...props.participant,
                role: event.target.value,
              })
            }
            placeholder="advocate"
          />
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Description
        </label>
        <Textarea
          value={props.participant.description}
          onChange={(event) =>
            props.onChange({
              ...props.participant,
              description: event.target.value,
            })
          }
          placeholder="Summarize this participant's perspective."
          className="[&_textarea]:min-h-10"
        />
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Provider
          </label>
          <Select
            value={activeProvider}
            onValueChange={(value) => {
              if (!value) {
                return;
              }
              props.onChange({
                ...props.participant,
                model: {
                  provider: value as ProviderKind,
                  model:
                    props.modelOptionsByProvider[value as ProviderKind][0]?.slug ?? activeModel,
                } satisfies ModelSelection,
              });
            }}
          >
            <SelectTrigger>{PROVIDER_DISPLAY_NAMES[activeProvider]}</SelectTrigger>
            <SelectPopup>
              {props.availableProviders.map((provider) => (
                <SelectItem key={provider} value={provider}>
                  {PROVIDER_DISPLAY_NAMES[provider]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>

        <div className="space-y-2">
          <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Model
          </label>
          <Select
            value={activeModel}
            onValueChange={(value) => {
              if (!value) {
                return;
              }
              props.onChange({
                ...props.participant,
                model: {
                  provider: activeProvider,
                  model: value,
                } satisfies ModelSelection,
              });
            }}
          >
            <SelectTrigger>
              {props.modelOptionsByProvider[activeProvider].find(
                (model) => model.slug === activeModel,
              )?.name ?? activeModel}
            </SelectTrigger>
            <SelectPopup>
              {props.modelOptionsByProvider[activeProvider].map((modelOption) => (
                <SelectItem key={modelOption.slug} value={modelOption.slug}>
                  {modelOption.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          System prompt
        </label>
        <Textarea
          value={props.participant.system}
          onChange={(event) =>
            props.onChange({
              ...props.participant,
              system: event.target.value,
            })
          }
          className="min-h-40"
          placeholder="Tell this participant how to behave in the discussion."
        />
      </div>
    </section>
  );
}
