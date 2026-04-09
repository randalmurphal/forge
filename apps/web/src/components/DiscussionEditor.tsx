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
import { MessagesSquareIcon, PlusIcon, SaveIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

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
import { useTheme } from "~/hooks/useTheme";
import { resolveDiscussionScopeColor, resolveRolePalette } from "~/lib/appearance";

const ALL_PROJECTS_VALUE = ALL_PROJECTS_DISCUSSION_FILTER;

function participantColor(index: number, palette: readonly string[]): string {
  return palette[index % palette.length] ?? palette[0]!;
}

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
  const { resolvedTheme } = useTheme();
  const serverConfig = useServerConfig();
  const projects = useStore((store) => store.projects);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const managedProjectFilter = useDiscussionStore((store) => store.managedProjectFilter);
  const setManagedProjectFilter = useDiscussionStore((store) => store.setManagedProjectFilter);
  const [draft, setDraft] = useState<DiscussionDefinition | null>(null);
  const [editorScope, setEditorScope] = useState<DiscussionScope>("global");
  const [draftDirty, setDraftDirty] = useState(false);
  const [loadedRouteKey, setLoadedRouteKey] = useState<string | null>(null);
  const [selectedParticipantIndex, setSelectedParticipantIndex] = useState(0);
  const prevRouteKeyRef = useRef<string | null>(null);
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
  const rolePalette = useMemo(
    () => resolveRolePalette(settings, resolvedTheme),
    [resolvedTheme, settings],
  );
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

  // Reset participant selection when switching discussions
  useEffect(() => {
    if (routeKey !== prevRouteKeyRef.current) {
      prevRouteKeyRef.current = routeKey;
      setSelectedParticipantIndex(0);
    }
  }, [routeKey]);

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

  // Clamp selected index
  const participantCount = draft?.participants.length ?? 0;
  const clampedIndex = Math.max(0, Math.min(selectedParticipantIndex, participantCount - 1));
  const selectedParticipant = draft?.participants[clampedIndex] ?? null;
  const selectedProvider = selectedParticipant?.model?.provider ?? fallbackModelSelection.provider;
  const selectedModel = selectedParticipant?.model?.model ?? fallbackModelSelection.model;

  const scopeBadgeLabel =
    editorScope === "global"
      ? "Global"
      : props.discussionScope === "project" && routeProject
        ? routeProject.name
        : (targetProject?.name ?? "Project");

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
        {/* ── Top bar: name + scope badge + actions ── */}
        <header className="border-b border-border px-4 py-3 sm:px-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-baseline gap-2.5">
              <h1 className="truncate text-lg font-semibold text-foreground">
                {draft?.name || "New discussion"}
              </h1>
              <span
                className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-[0.04em]"
                style={{
                  backgroundColor: `color-mix(in srgb, ${resolveDiscussionScopeColor(
                    settings,
                    resolvedTheme,
                    editorScope,
                  )} 12%, transparent)`,
                  color: resolveDiscussionScopeColor(settings, resolvedTheme, editorScope),
                }}
              >
                {scopeBadgeLabel}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {props.discussionName !== null && props.discussionScope !== null ? (
                <button
                  type="button"
                  onClick={() => void deleteMutation.mutateAsync()}
                  disabled={deleteMutation.isPending}
                  className="rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground/60 transition-colors hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
                >
                  Delete
                </button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void navigate({ to: "/agent-modes/discussions" })}
              >
                <PlusIcon className="size-3.5" />
                New
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void saveMutation.mutateAsync()}
                disabled={saveMutation.isPending || validationMessage !== null}
              >
                <SaveIcon className="size-3.5" />
                {saveMutation.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[272px_minmax(0,1fr)]">
          {/* ── Sidebar ── */}
          <aside className="min-h-0 border-b border-border/70 bg-card/50 lg:border-r lg:border-b-0">
            <div className="space-y-3 border-b border-border/70 px-4 py-3">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/60">
                Discussions
              </span>

              {orderedProjects.length > 0 ? (
                <div className="space-y-1">
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
                <div className="rounded-[10px] border border-dashed border-border/70 px-3 py-4 text-xs text-muted-foreground/60">
                  No discussions yet.
                </div>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {renderedDiscussions.map((discussion) => {
                    const active =
                      props.discussionName === discussion.name &&
                      props.discussionScope === discussion.scope &&
                      (discussion.scope !== "project" ||
                        props.projectId === discussion.ownerProjectId);
                    return (
                      <button
                        key={`${discussion.scope}:${discussion.ownerProjectId ?? "global"}:${discussion.name}`}
                        type="button"
                        className={cn(
                          "w-full cursor-pointer rounded-[10px] border px-3 py-2.5 text-left transition-all",
                          active
                            ? "border-border bg-[var(--panel-elevated)]"
                            : "border-transparent hover:bg-[var(--panel-elevated)]",
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
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-foreground">
                            {discussion.name}
                          </span>
                          <span
                            className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-[0.04em]"
                            style={{
                              backgroundColor: `color-mix(in srgb, ${resolveDiscussionScopeColor(
                                settings,
                                resolvedTheme,
                                discussion.scope,
                              )} 12%, transparent)`,
                              color: resolveDiscussionScopeColor(
                                settings,
                                resolvedTheme,
                                discussion.scope,
                              ),
                            }}
                          >
                            {discussion.scope === "global"
                              ? "Global"
                              : (discussion.ownerProjectName ?? "Project")}
                          </span>
                          {!discussion.effective ? (
                            <span className="rounded-full bg-muted-foreground/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-[0.04em] text-muted-foreground/60">
                              Shadowed
                            </span>
                          ) : null}
                        </div>
                        {/* Participant role dots */}
                        <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground/60">
                          {discussion.participantRoles.map((role, roleIndex) => (
                            <span key={role} className="inline-flex items-center gap-1">
                              {roleIndex > 0 ? <span className="text-border">·</span> : null}
                              <span
                                className="inline-block size-[5px] shrink-0 rounded-full"
                                style={{ background: participantColor(roleIndex, rolePalette) }}
                              />
                              <span>{role}</span>
                            </span>
                          ))}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>

          {/* ── Main editor ── */}
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
              <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-5 py-7 sm:px-9">
                {/* ── Identity row: name + scope ── */}
                <div className="flex items-end gap-3.5">
                  <div className="min-w-0 flex-1 max-w-56 space-y-1">
                    <label className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground/60">
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
                  <div className="space-y-1">
                    <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground/60">
                      Scope
                    </span>
                    <div className="flex overflow-hidden rounded-lg border border-border bg-[var(--panel-elevated)]">
                      <button
                        type="button"
                        onClick={() => {
                          setEditorScope("global");
                          setDraftDirty(true);
                        }}
                        className={cn(
                          "px-3.5 py-[7px] text-xs font-medium transition-all whitespace-nowrap",
                          editorScope === "global"
                            ? "text-white"
                            : "text-muted-foreground/60 hover:text-muted-foreground",
                        )}
                        style={
                          editorScope === "global"
                            ? { backgroundColor: "var(--feature-discussion-global)" }
                            : undefined
                        }
                      >
                        Global
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditorScope("project");
                          setDraftDirty(true);
                        }}
                        disabled={orderedProjects.length === 0}
                        className={cn(
                          "px-3.5 py-[7px] text-xs font-medium transition-all whitespace-nowrap",
                          editorScope === "project"
                            ? "text-white"
                            : "text-muted-foreground/60 hover:text-muted-foreground disabled:pointer-events-none disabled:opacity-50",
                        )}
                        style={
                          editorScope === "project"
                            ? { backgroundColor: "var(--feature-discussion-project)" }
                            : undefined
                        }
                      >
                        Project
                      </button>
                    </div>
                  </div>
                </div>

                {/* Scope detail */}
                {editorScope === "project" ? (
                  <p className="text-xs text-muted-foreground">{scopeProjectLabel}</p>
                ) : null}

                {/* ── Description ── */}
                <div className="space-y-1">
                  <label className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground/60">
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
                    className="[&_textarea]:min-h-10"
                  />
                </div>

                {/* Validation message */}
                {validationMessage ? (
                  <div
                    className="rounded-lg border px-3 py-2 text-sm"
                    style={{
                      borderColor: "color-mix(in srgb, var(--warning) 20%, transparent)",
                      backgroundColor: "color-mix(in srgb, var(--warning) 10%, transparent)",
                      color: "var(--warning-foreground)",
                    }}
                  >
                    {validationMessage}
                  </div>
                ) : null}

                {/* ── Section divider ── */}
                <div className="h-px bg-border" />

                {/* ── Participants header ── */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3.5">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/60">
                      Participants
                    </span>
                    <div className="flex items-center gap-1.5 rounded-full border border-border bg-[var(--panel)] px-2.5 py-1 text-[11px] text-muted-foreground/60">
                      <span>max</span>
                      <input
                        type="number"
                        min={1}
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
                        className="w-9 bg-transparent text-center text-[11px] font-semibold text-muted-foreground outline-none focus:text-foreground"
                      />
                      <span>turns</span>
                    </div>
                  </div>
                </div>

                {/* ── Participant card strip ── */}
                <div className="flex gap-2">
                  {draft.participants.map((participant, index) => {
                    const color = participantColor(index, rolePalette);
                    const isActive = clampedIndex === index;
                    const providerKey =
                      participant.model?.provider ?? fallbackModelSelection.provider;
                    const modelKey = participant.model?.model ?? fallbackModelSelection.model;
                    const modelName =
                      modelOptionsByProvider[providerKey]?.find((m) => m.slug === modelKey)?.name ??
                      modelKey;
                    return (
                      <button
                        // eslint-disable-next-line react/no-array-index-key -- participants have no stable ID; role can be duplicated during edits
                        key={`${participant.role}-${index}`}
                        type="button"
                        onClick={() => setSelectedParticipantIndex(index)}
                        className={cn(
                          "relative min-w-0 flex-1 cursor-pointer overflow-hidden rounded-xl border bg-[var(--panel)] p-3.5 pt-4 text-left transition-all",
                          isActive
                            ? "bg-[var(--panel-elevated)]"
                            : "border-border hover:bg-[var(--panel-elevated)]",
                        )}
                        style={
                          isActive
                            ? {
                                borderColor: `color-mix(in srgb, ${color} 30%, transparent)`,
                                boxShadow: "var(--panel-shadow-active)",
                              }
                            : undefined
                        }
                      >
                        {/* Color stripe */}
                        <div
                          className={cn(
                            "absolute inset-x-0 top-0 h-[2.5px] transition-opacity",
                            isActive ? "opacity-100" : "opacity-70",
                          )}
                          style={{ background: color }}
                        />
                        <div className="text-sm font-semibold text-foreground">
                          {participant.role || `participant-${index + 1}`}
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground/60">
                          {participant.description || "No description"}
                        </div>
                        <span className="mt-2.5 inline-flex items-center gap-1 rounded-full bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                          >
                            <circle cx="12" cy="12" r="9" />
                          </svg>
                          {PROVIDER_DISPLAY_NAMES[providerKey]} · {modelName}
                        </span>
                      </button>
                    );
                  })}
                  {/* Add participant button */}
                  <button
                    type="button"
                    onClick={() => {
                      updateDraft((current) => ({
                        ...current,
                        participants: [
                          ...current.participants,
                          createParticipant(current.participants.length, fallbackModelSelection),
                        ],
                      }));
                      setSelectedParticipantIndex(participantCount);
                    }}
                    className="flex w-12 shrink-0 cursor-pointer items-center justify-center rounded-xl border-[1.5px] border-dashed border-border text-xl text-muted-foreground/60 transition-all hover:border-muted-foreground/60 hover:bg-[var(--panel)] hover:text-muted-foreground"
                    title="Add participant"
                  >
                    +
                  </button>
                </div>

                {/* ── Editor panel with connector ── */}
                {selectedParticipant && (
                  <div className="relative">
                    {/* Connector nub */}
                    <div
                      className="absolute -top-1.5 z-10 size-3 rotate-45 border border-b-0 border-r-0 border-border bg-[var(--panel)] transition-[left] duration-200 ease-out"
                      style={{
                        left:
                          participantCount <= 1
                            ? "60px"
                            : `calc(${((clampedIndex + 0.5) / (participantCount + 0.6)) * 100}% - 6px)`,
                      }}
                    />
                    <div
                      className="rounded-xl border border-border bg-[var(--panel)] p-5"
                      style={{ boxShadow: "var(--panel-shadow)" }}
                    >
                      {/* Editor header */}
                      <div className="mb-4 flex items-center justify-between">
                        <span className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
                          <span
                            className="inline-block size-[7px] shrink-0 rounded-full"
                            style={{ background: participantColor(clampedIndex, rolePalette) }}
                          />
                          {selectedParticipant.role || `participant-${clampedIndex + 1}`}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            const removedIndex = clampedIndex;
                            updateDraft((current) => ({
                              ...current,
                              participants: current.participants.filter(
                                (_, i) => i !== removedIndex,
                              ),
                            }));
                            setSelectedParticipantIndex(Math.max(0, removedIndex - 1));
                          }}
                          disabled={participantCount <= 2}
                          className="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground/60 transition-colors hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
                        >
                          Remove
                        </button>
                      </div>

                      {/* Editor fields */}
                      <div className="space-y-3.5">
                        {/* Role + Description row */}
                        <div className="grid gap-3.5 md:grid-cols-2">
                          <div className="space-y-1">
                            <label className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground/60">
                              Role
                            </label>
                            <Input
                              value={selectedParticipant.role}
                              onChange={(event) =>
                                updateDraft((current) => ({
                                  ...current,
                                  participants: current.participants.map((p, i) =>
                                    i === clampedIndex ? { ...p, role: event.target.value } : p,
                                  ),
                                }))
                              }
                              placeholder="advocate"
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground/60">
                              Description
                            </label>
                            <Input
                              value={selectedParticipant.description}
                              onChange={(event) =>
                                updateDraft((current) => ({
                                  ...current,
                                  participants: current.participants.map((p, i) =>
                                    i === clampedIndex
                                      ? { ...p, description: event.target.value }
                                      : p,
                                  ),
                                }))
                              }
                              placeholder="Argues for the current direction"
                            />
                          </div>
                        </div>

                        {/* Provider + Model row */}
                        <div className="grid gap-3.5 md:grid-cols-2">
                          <div className="space-y-1">
                            <label className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground/60">
                              Provider
                            </label>
                            <Select
                              value={selectedProvider}
                              onValueChange={(value) => {
                                if (!value) {
                                  return;
                                }
                                updateDraft((current) => ({
                                  ...current,
                                  participants: current.participants.map((p, i) =>
                                    i === clampedIndex
                                      ? {
                                          ...p,
                                          model: {
                                            provider: value as ProviderKind,
                                            model:
                                              modelOptionsByProvider[value as ProviderKind][0]
                                                ?.slug ?? selectedModel,
                                          } satisfies ModelSelection,
                                        }
                                      : p,
                                  ),
                                }));
                              }}
                            >
                              <SelectTrigger>
                                {PROVIDER_DISPLAY_NAMES[selectedProvider]}
                              </SelectTrigger>
                              <SelectPopup>
                                {selectableProviders.map((provider) => (
                                  <SelectItem key={provider} value={provider}>
                                    {PROVIDER_DISPLAY_NAMES[provider]}
                                  </SelectItem>
                                ))}
                              </SelectPopup>
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <label className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground/60">
                              Model
                            </label>
                            <Select
                              value={selectedModel}
                              onValueChange={(value) => {
                                if (!value) {
                                  return;
                                }
                                updateDraft((current) => ({
                                  ...current,
                                  participants: current.participants.map((p, i) =>
                                    i === clampedIndex
                                      ? {
                                          ...p,
                                          model: {
                                            provider: selectedProvider,
                                            model: value,
                                          } satisfies ModelSelection,
                                        }
                                      : p,
                                  ),
                                }));
                              }}
                            >
                              <SelectTrigger>
                                {modelOptionsByProvider[selectedProvider]?.find(
                                  (model) => model.slug === selectedModel,
                                )?.name ?? selectedModel}
                              </SelectTrigger>
                              <SelectPopup>
                                {modelOptionsByProvider[selectedProvider]?.map((modelOption) => (
                                  <SelectItem key={modelOption.slug} value={modelOption.slug}>
                                    {modelOption.name}
                                  </SelectItem>
                                ))}
                              </SelectPopup>
                            </Select>
                          </div>
                        </div>

                        {/* System prompt */}
                        <div className="space-y-1">
                          <label className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground/60">
                            System prompt
                          </label>
                          <Textarea
                            value={selectedParticipant.system}
                            onChange={(event) =>
                              updateDraft((current) => ({
                                ...current,
                                participants: current.participants.map((p, i) =>
                                  i === clampedIndex ? { ...p, system: event.target.value } : p,
                                ),
                              }))
                            }
                            className="[&_textarea]:min-h-22"
                            placeholder="Tell this participant how to behave in the discussion."
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </main>
        </div>
      </div>
    </AgentModesPage>
  );
}
