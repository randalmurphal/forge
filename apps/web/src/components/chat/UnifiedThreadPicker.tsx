import type { DiscussionSummary, ProviderKind, ServerProvider } from "@forgetools/contracts";
import { resolveSelectableModel } from "@forgetools/shared/model";
import { memo, useEffect, useMemo, useState } from "react";
import { type ProviderPickerKind, PROVIDER_OPTIONS } from "../../session-logic";
import { ChevronDownIcon, MessagesSquareIcon, WorkflowIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { ClaudeAI, OpenAI, type Icon } from "../Icons";
import { cn } from "~/lib/utils";
import { getProviderSnapshot } from "../../providerModels";
import { useTheme } from "~/hooks/useTheme";
import { useSettings } from "~/hooks/useSettings";
import { resolveProviderAccentColor } from "~/lib/appearance";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useWorkflowStore, useWorkflows } from "../../stores/workflowStore";
import { useDiscussionStore, useDiscussions } from "../../stores/discussionStore";
import { useStore } from "../../store";
import {
  filterWorkflowSummariesForProject,
  sortWorkflowSummariesForPicker,
} from "../WorkflowPicker.logic";
import type { ThreadId } from "@forgetools/contracts";

const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter((option) => option.available) as Array<{
  value: ProviderKind;
  label: string;
  available: true;
}>;

const PROVIDER_ICON_BY_PROVIDER: Record<ProviderPickerKind, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  cursor: ClaudeAI, // unused but satisfies the record type
};

export const UnifiedThreadPicker = memo(function UnifiedThreadPicker(props: {
  threadId: ThreadId;
  provider: ProviderKind;
  model: string;
  lockedProvider: ProviderKind | null;
  discussionLabelOverride?: string | null;
  providers?: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  onProviderModelChange: (provider: ProviderKind, model: string) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const settings = useSettings((current) => current);
  const { resolvedTheme } = useTheme();

  // --- Model selection state ---
  const activeProvider = props.lockedProvider ?? props.provider;
  const selectedProviderOptions = props.modelOptionsByProvider[activeProvider];
  const selectedModelLabel =
    selectedProviderOptions.find((option) => option.slug === props.model)?.name ?? props.model;
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[activeProvider];
  const providerIconStyle = (provider: ProviderKind | ProviderPickerKind) =>
    provider === "claudeAgent"
      ? {
          color: resolveProviderAccentColor(
            settings,
            resolvedTheme,
            "claudeAgent",
            "var(--feature-provider-claude)",
          ),
        }
      : undefined;

  const handleModelChange = (provider: ProviderKind, value: string) => {
    if (props.disabled) return;
    if (!value) return;
    const resolvedModel = resolveSelectableModel(
      provider,
      value,
      props.modelOptionsByProvider[provider],
    );
    if (!resolvedModel) return;
    props.onProviderModelChange(provider, resolvedModel);
    // Selecting a model clears any active workflow/discussion
    if (resolvedWorkflowId !== null || resolvedDiscussionId !== null) {
      setDraftThreadContext(props.threadId, {
        workflowId: null,
        discussionId: null,
        discussionRoleModels: null,
      });
      setSelectedWorkflowId(null);
    }
    setIsMenuOpen(false);
  };

  // --- Workflow/discussion selection state ---
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(props.threadId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const projects = useStore((store) => store.projects);
  const storedWorkflows = useWorkflowStore((store) => store.availableWorkflows);
  const selectedWorkflowId = useWorkflowStore((store) => store.selectedWorkflowId);
  const setSelectedWorkflowId = useWorkflowStore((store) => store.setSelectedWorkflowId);
  const workflowQuery = useWorkflows();
  const availableWorkflows = workflowQuery.data ?? storedWorkflows;

  // Workflows: filter by project, sort for display (no more hasDeliberation split)
  const workflows = useMemo(
    () =>
      sortWorkflowSummariesForPicker(
        filterWorkflowSummariesForProject(availableWorkflows, draftThread?.projectId ?? null),
      ),
    [availableWorkflows, draftThread?.projectId],
  );

  // Discussions: loaded from discussion.list API via dedicated store
  const storedDiscussions = useDiscussionStore((store) => store.availableDiscussions);
  const discussionWorkspaceRoot = projects.find(
    (project) => project.id === (draftThread?.projectId ?? null),
  )?.cwd;
  const discussionQuery = useDiscussions(discussionWorkspaceRoot);
  const discussions: ReadonlyArray<DiscussionSummary> =
    (discussionQuery.data as ReadonlyArray<DiscussionSummary> | undefined) ?? storedDiscussions;

  // Sync workflow store selection with draft
  useEffect(() => {
    const draftWorkflowId = draftThread?.workflowId ?? null;
    if (selectedWorkflowId !== draftWorkflowId) {
      setSelectedWorkflowId(draftWorkflowId);
    }
  }, [draftThread?.workflowId, selectedWorkflowId, setSelectedWorkflowId]);

  // Clear workflow if no longer available
  useEffect(() => {
    if (!draftThread?.workflowId) return;
    if (!workflowQuery.isSuccess) return;
    if (workflows.some((w) => w.workflowId === draftThread.workflowId)) return;
    setDraftThreadContext(props.threadId, { workflowId: null });
    setSelectedWorkflowId(null);
  }, [
    draftThread?.workflowId,
    props.threadId,
    setDraftThreadContext,
    setSelectedWorkflowId,
    workflows,
    workflowQuery.isSuccess,
  ]);

  // Clear discussion if no longer available
  useEffect(() => {
    if (!draftThread?.discussionId) return;
    if (!discussionQuery.isSuccess) return;
    if (discussions.some((d) => d.name === draftThread.discussionId)) return;
    setDraftThreadContext(props.threadId, { discussionId: null, discussionRoleModels: null });
  }, [
    draftThread?.discussionId,
    props.threadId,
    setDraftThreadContext,
    discussions,
    discussionQuery.isSuccess,
  ]);

  const resolvedWorkflowId = draftThread?.workflowId ?? null;
  const resolvedDiscussionId = draftThread?.discussionId ?? null;
  const selectedWorkflow = resolvedWorkflowId
    ? workflows.find((w) => w.workflowId === resolvedWorkflowId)
    : null;
  const selectedDiscussion = resolvedDiscussionId
    ? discussions.find((d) => d.name === resolvedDiscussionId)
    : null;

  const selectWorkflow = (value: string) => {
    const nextWorkflowId = workflows.find((w) => w.workflowId === value)?.workflowId ?? null;
    setDraftThreadContext(props.threadId, {
      workflowId: nextWorkflowId,
      discussionId: null,
      discussionRoleModels: null,
    });
    setSelectedWorkflowId(nextWorkflowId);
    setIsMenuOpen(false);
  };

  const selectDiscussion = (name: string) => {
    const discussion = discussions.find((d) => d.name === name);
    if (!discussion) return;
    setDraftThreadContext(props.threadId, {
      discussionId: discussion.name,
      workflowId: null,
      discussionRoleModels: null,
    });
    setSelectedWorkflowId(null);
    setIsMenuOpen(false);
  };

  // --- Trigger label ---
  const resolvedDiscussionLabel =
    props.discussionLabelOverride ?? selectedDiscussion?.name ?? selectedWorkflow?.name ?? null;
  const isWorkflowActive = resolvedDiscussionLabel !== null;
  const isDiscussionActive = selectedDiscussion !== null || props.discussionLabelOverride != null;
  const triggerLabel = isWorkflowActive ? resolvedDiscussionLabel : selectedModelLabel;

  const showWorkflowSection = draftThread !== null;

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            data-chat-provider-model-picker="true"
            className={cn(
              "min-w-0 justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 [&_svg]:mx-0",
              props.compact ? "max-w-48 shrink-0" : "max-w-56 shrink sm:max-w-64 sm:px-3",
            )}
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn(
            "flex min-w-0 w-full box-border items-center gap-2 overflow-hidden",
            props.compact ? "max-w-44 sm:pl-1" : undefined,
          )}
        >
          {isWorkflowActive ? (
            isDiscussionActive ? (
              <MessagesSquareIcon
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground/70"
              />
            ) : (
              <WorkflowIcon
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground/70"
              />
            )
          ) : (
            <ProviderIcon
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0",
                activeProvider === "claudeAgent" ? undefined : "text-muted-foreground/70",
              )}
              style={providerIconStyle(activeProvider)}
            />
          )}
          <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-56">
        {/* Providers with model sub-menus */}
        {props.lockedProvider !== null ? (
          <MenuGroup>
            <MenuRadioGroup
              value={isWorkflowActive ? "" : props.model}
              onValueChange={(value) => handleModelChange(props.lockedProvider!, value)}
            >
              {props.modelOptionsByProvider[props.lockedProvider].map((modelOption) => (
                <MenuRadioItem
                  key={`${props.lockedProvider}:${modelOption.slug}`}
                  value={modelOption.slug}
                  onClick={() => setIsMenuOpen(false)}
                >
                  {modelOption.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        ) : (
          <>
            {AVAILABLE_PROVIDER_OPTIONS.map((option) => {
              const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
              const liveProvider = props.providers
                ? getProviderSnapshot(props.providers, option.value)
                : undefined;

              if (liveProvider && liveProvider.status !== "ready") {
                const unavailableLabel = !liveProvider.enabled
                  ? "Disabled"
                  : !liveProvider.installed
                    ? "Not installed"
                    : "Unavailable";
                return (
                  <MenuItem key={option.value} disabled>
                    <OptionIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0 opacity-80",
                        option.value === "claudeAgent" ? undefined : "text-muted-foreground/70",
                      )}
                      style={providerIconStyle(option.value)}
                    />
                    <span>{option.label}</span>
                    <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                      {unavailableLabel}
                    </span>
                  </MenuItem>
                );
              }

              return (
                <MenuSub key={option.value}>
                  <MenuSubTrigger>
                    <OptionIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0",
                        option.value === "claudeAgent" ? undefined : "text-muted-foreground/70",
                      )}
                      style={providerIconStyle(option.value)}
                    />
                    {option.label}
                  </MenuSubTrigger>
                  <MenuSubPopup className="[--available-height:min(24rem,70vh)]" sideOffset={4}>
                    <MenuGroup>
                      <MenuRadioGroup
                        value={
                          !isWorkflowActive && props.provider === option.value ? props.model : ""
                        }
                        onValueChange={(value) => handleModelChange(option.value, value)}
                      >
                        {props.modelOptionsByProvider[option.value].map((modelOption) => (
                          <MenuRadioItem
                            key={`${option.value}:${modelOption.slug}`}
                            value={modelOption.slug}
                            onClick={() => setIsMenuOpen(false)}
                          >
                            {modelOption.name}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                  </MenuSubPopup>
                </MenuSub>
              );
            })}
          </>
        )}

        {/* Discussions sub-menu */}
        {showWorkflowSection && discussions.length > 0 ? (
          <>
            <MenuSeparator />
            <WorkflowSubMenu
              label="Discussions"
              icon={
                <MessagesSquareIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground/70"
                />
              }
              items={discussions.map((d) => ({ id: d.name, name: d.name }))}
              selectedId={resolvedDiscussionId}
              onSelect={selectDiscussion}
            />
          </>
        ) : null}

        {/* Workflows sub-menu */}
        {showWorkflowSection && workflows.length > 0 ? (
          <>
            <MenuSeparator />
            <WorkflowSubMenu
              label="Workflows"
              icon={
                <WorkflowIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground/70"
                />
              }
              items={workflows.map((w) => ({ id: w.workflowId, name: w.name }))}
              selectedId={resolvedWorkflowId}
              onSelect={selectWorkflow}
            />
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});

function WorkflowSubMenu(props: {
  label: string;
  icon: React.ReactNode;
  items: ReadonlyArray<{ id: string; name: string }>;
  selectedId: string | null;
  onSelect: (value: string) => void;
}) {
  const activeValue = props.items.some((item) => item.id === props.selectedId)
    ? props.selectedId!
    : "";

  return (
    <MenuSub>
      <MenuSubTrigger>
        {props.icon}
        {props.label}
      </MenuSubTrigger>
      <MenuSubPopup className="[--available-height:min(24rem,70vh)]" sideOffset={4}>
        <MenuGroup>
          <MenuRadioGroup value={activeValue} onValueChange={props.onSelect}>
            {props.items.map((item) => (
              <MenuRadioItem key={item.id} value={item.id}>
                {item.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}
