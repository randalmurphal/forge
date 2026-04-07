import type { ProviderKind, ServerProvider, WorkflowSummary } from "@forgetools/contracts";
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
import { useComposerDraftStore } from "../../composerDraftStore";
import { useWorkflowStore, useWorkflows } from "../../stores/workflowStore";
import { splitWorkflowsByCategory } from "../WorkflowPicker.logic";
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

function providerIconClassName(provider: ProviderKind | ProviderPickerKind): string {
  return provider === "claudeAgent" ? "text-[#d97757]" : "text-muted-foreground/70";
}

export const UnifiedThreadPicker = memo(function UnifiedThreadPicker(props: {
  threadId: ThreadId;
  provider: ProviderKind;
  model: string;
  lockedProvider: ProviderKind | null;
  patternLabelOverride?: string | null;
  providers?: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  onProviderModelChange: (provider: ProviderKind, model: string) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // --- Model selection state ---
  const activeProvider = props.lockedProvider ?? props.provider;
  const selectedProviderOptions = props.modelOptionsByProvider[activeProvider];
  const selectedModelLabel =
    selectedProviderOptions.find((option) => option.slug === props.model)?.name ?? props.model;
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[activeProvider];

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
    if (resolvedWorkflowId !== null) {
      setDraftThreadContext(props.threadId, { workflowId: null });
      setSelectedWorkflowId(null);
    }
    setIsMenuOpen(false);
  };

  // --- Workflow/discussion selection state ---
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(props.threadId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const storedWorkflows = useWorkflowStore((store) => store.availableWorkflows);
  const selectedWorkflowId = useWorkflowStore((store) => store.selectedWorkflowId);
  const setSelectedWorkflowId = useWorkflowStore((store) => store.setSelectedWorkflowId);
  const workflowQuery = useWorkflows();
  const availableWorkflows = workflowQuery.data ?? storedWorkflows;

  const { discussions, workflows } = useMemo(
    () =>
      splitWorkflowsByCategory({
        projectId: draftThread?.projectId ?? null,
        workflows: availableWorkflows,
      }),
    [availableWorkflows, draftThread?.projectId],
  );

  const allSelectable = useMemo(() => [...discussions, ...workflows], [discussions, workflows]);

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
    if (allSelectable.some((w) => w.workflowId === draftThread.workflowId)) return;
    setDraftThreadContext(props.threadId, { workflowId: null });
    setSelectedWorkflowId(null);
  }, [
    draftThread?.workflowId,
    props.threadId,
    setDraftThreadContext,
    setSelectedWorkflowId,
    allSelectable,
    workflowQuery.isSuccess,
  ]);

  const resolvedWorkflowId = draftThread?.workflowId ?? null;
  const selectedWorkflow = resolvedWorkflowId
    ? allSelectable.find((w) => w.workflowId === resolvedWorkflowId)
    : null;

  const selectWorkflow = (value: string) => {
    const nextWorkflowId = allSelectable.find((w) => w.workflowId === value)?.workflowId ?? null;
    setDraftThreadContext(props.threadId, { workflowId: nextWorkflowId });
    setSelectedWorkflowId(nextWorkflowId);
    setIsMenuOpen(false);
  };

  // --- Trigger label ---
  const resolvedPatternLabel = props.patternLabelOverride ?? selectedWorkflow?.name ?? null;
  const isWorkflowActive = resolvedPatternLabel !== null;
  const triggerLabel = isWorkflowActive ? resolvedPatternLabel : selectedModelLabel;

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
            selectedWorkflow?.hasDeliberation ? (
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
              className={cn("size-4 shrink-0", providerIconClassName(activeProvider))}
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
                        providerIconClassName(option.value),
                      )}
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
                      className={cn("size-4 shrink-0", providerIconClassName(option.value))}
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
              items={workflows}
              selectedWorkflowId={resolvedWorkflowId}
              onSelect={selectWorkflow}
            />
          </>
        ) : null}

        {/* Discussions sub-menu */}
        {showWorkflowSection && discussions.length > 0 ? (
          <>
            {workflows.length === 0 ? <MenuSeparator /> : null}
            <WorkflowSubMenu
              label="Discussions"
              icon={
                <MessagesSquareIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground/70"
                />
              }
              items={discussions}
              selectedWorkflowId={resolvedWorkflowId}
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
  items: WorkflowSummary[];
  selectedWorkflowId: string | null;
  onSelect: (value: string) => void;
}) {
  const activeValue = props.items.some((w) => w.workflowId === props.selectedWorkflowId)
    ? props.selectedWorkflowId!
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
              <MenuRadioItem key={item.workflowId} value={item.workflowId}>
                {item.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}
