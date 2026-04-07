import type { ProviderKind, ServerProvider } from "@forgetools/contracts";
import { resolveSelectableModel } from "@forgetools/shared/model";
import { memo, useEffect, useMemo, useState } from "react";
import { type ProviderPickerKind, PROVIDER_OPTIONS } from "../../session-logic";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
  MenuItem,
} from "../ui/menu";
import { ClaudeAI, OpenAI, type Icon } from "../Icons";
import { cn } from "~/lib/utils";
import { getProviderSnapshot } from "../../providerModels";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useWorkflowStore, useWorkflows } from "../../stores/workflowStore";
import {
  buildWorkflowPickerSections,
  compactWorkflowPickerSections,
  NO_WORKFLOW_VALUE,
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

function providerIconClassName(provider: ProviderKind | ProviderPickerKind): string {
  return provider === "claudeAgent" ? "text-[#d97757]" : "text-muted-foreground/70";
}

export const UnifiedThreadPicker = memo(function UnifiedThreadPicker(props: {
  threadId: ThreadId;
  provider: ProviderKind;
  model: string;
  lockedProvider: ProviderKind | null;
  patternLabelOverride?: string | null;
  hideModelSection?: boolean;
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
    setIsMenuOpen(false);
  };

  // --- Pattern/workflow selection state ---
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(props.threadId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const storedWorkflows = useWorkflowStore((store) => store.availableWorkflows);
  const selectedWorkflowId = useWorkflowStore((store) => store.selectedWorkflowId);
  const setSelectedWorkflowId = useWorkflowStore((store) => store.setSelectedWorkflowId);
  const workflowQuery = useWorkflows();
  const availableWorkflows = workflowQuery.data ?? storedWorkflows;

  const thinkingPatterns = useMemo(() => {
    const sections = compactWorkflowPickerSections(
      buildWorkflowPickerSections({
        projectId: draftThread?.projectId ?? null,
        workflows: availableWorkflows,
      }),
    );
    const thinkingSection = sections.find((section) => section.key === "built-in-thinking");
    return thinkingSection?.workflows ?? [];
  }, [availableWorkflows, draftThread?.projectId]);

  const selectableWorkflows = useMemo(() => {
    const sections = compactWorkflowPickerSections(
      buildWorkflowPickerSections({
        projectId: draftThread?.projectId ?? null,
        workflows: availableWorkflows,
      }),
    );
    return sections.flatMap((section) => section.workflows);
  }, [availableWorkflows, draftThread?.projectId]);

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
    if (selectableWorkflows.some((workflow) => workflow.workflowId === draftThread.workflowId)) {
      return;
    }
    setDraftThreadContext(props.threadId, { workflowId: null });
    setSelectedWorkflowId(null);
  }, [
    draftThread?.workflowId,
    props.threadId,
    setDraftThreadContext,
    setSelectedWorkflowId,
    selectableWorkflows,
    workflowQuery.isSuccess,
  ]);

  const resolvedWorkflowId = draftThread?.workflowId ?? null;
  const selectedPattern = resolvedWorkflowId
    ? thinkingPatterns.find((w) => w.workflowId === resolvedWorkflowId)
    : null;

  const selectPattern = (value: string) => {
    const nextWorkflowId =
      value === NO_WORKFLOW_VALUE
        ? null
        : (selectableWorkflows.find((w) => w.workflowId === value)?.workflowId ?? null);
    setDraftThreadContext(props.threadId, { workflowId: nextWorkflowId });
    setSelectedWorkflowId(nextWorkflowId);
  };

  // --- Trigger label ---
  const resolvedPatternLabel = props.patternLabelOverride ?? selectedPattern?.name ?? null;
  const triggerLabel =
    resolvedPatternLabel !== null
      ? props.hideModelSection
        ? resolvedPatternLabel
        : `${resolvedPatternLabel} \u00b7 ${selectedModelLabel}`
      : selectedModelLabel;

  // When a draft thread doesn't exist (started thread), hide pattern section
  const showPatternSection = draftThread !== null;

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
          {!props.hideModelSection ? (
            <ProviderIcon
              aria-hidden="true"
              className={cn("size-4 shrink-0", providerIconClassName(activeProvider))}
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-56">
        {/* Section 1: Models */}
        {!props.hideModelSection && props.lockedProvider !== null ? (
          <MenuGroup>
            <MenuGroupLabel>Models</MenuGroupLabel>
            <MenuRadioGroup
              value={props.model}
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
        ) : !props.hideModelSection ? (
          <ModelSelectionSection
            provider={props.provider}
            model={props.model}
            {...(props.providers ? { providers: props.providers } : {})}
            modelOptionsByProvider={props.modelOptionsByProvider}
            onModelChange={handleModelChange}
            onCloseMenu={() => setIsMenuOpen(false)}
          />
        ) : null}

        {/* Section 2: Patterns */}
        {showPatternSection && thinkingPatterns.length > 0 ? (
          <>
            {!props.hideModelSection ? <MenuSeparator /> : null}
            <MenuGroup>
              <MenuGroupLabel>Patterns</MenuGroupLabel>
              <MenuRadioGroup
                value={resolvedWorkflowId ?? NO_WORKFLOW_VALUE}
                onValueChange={selectPattern}
              >
                <MenuRadioItem value={NO_WORKFLOW_VALUE}>(none)</MenuRadioItem>
                {thinkingPatterns.map((pattern) => (
                  <MenuRadioItem
                    key={pattern.workflowId}
                    value={pattern.workflowId}
                    className="min-h-11 items-start"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5 py-0.5">
                      <span className="truncate font-medium text-foreground">{pattern.name}</span>
                      {pattern.description.trim().length > 0 ? (
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {pattern.description}
                        </span>
                      ) : null}
                    </div>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});

/**
 * Renders available provider groups with model sub-menus when the provider is not locked.
 */
function ModelSelectionSection(props: {
  provider: ProviderKind;
  model: string;
  providers?: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  onModelChange: (provider: ProviderKind, value: string) => void;
  onCloseMenu: () => void;
}) {
  return (
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
                className={cn("size-4 shrink-0 opacity-80", providerIconClassName(option.value))}
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
                  value={props.provider === option.value ? props.model : ""}
                  onValueChange={(value) => props.onModelChange(option.value, value)}
                >
                  {props.modelOptionsByProvider[option.value].map((modelOption) => (
                    <MenuRadioItem
                      key={`${option.value}:${modelOption.slug}`}
                      value={modelOption.slug}
                      onClick={props.onCloseMenu}
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
  );
}
