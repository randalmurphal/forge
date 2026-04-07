import type {
  DeliberationParticipant,
  ModelSelection,
  ProviderKind,
  ThreadId,
  WorkflowDefinition,
  WorkflowId,
} from "@forgetools/contracts";
import { memo, useMemo } from "react";
import { type ProviderPickerKind, PROVIDER_OPTIONS } from "../../session-logic";
import { ChevronDownIcon, UsersIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { ClaudeAI, OpenAI, type Icon } from "../Icons";
import { cn } from "~/lib/utils";
import { useWorkflow } from "../../stores/workflowStore";
import { useComposerDraftStore } from "../../composerDraftStore";
import { getProviderSnapshot } from "../../providerModels";
import type { ServerProvider } from "@forgetools/contracts";

const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter((o) => o.available) as Array<{
  value: ProviderKind;
  label: string;
  available: true;
}>;

const PROVIDER_ICON_BY_PROVIDER: Record<ProviderPickerKind, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  cursor: ClaudeAI,
};

function providerIconClassName(provider: ProviderKind | ProviderPickerKind): string {
  return provider === "claudeAgent" ? "text-[#d97757]" : "text-muted-foreground/70";
}

function formatRoleLabel(role: string): string {
  return role
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function collectDiscussionParticipants(workflow: WorkflowDefinition): DeliberationParticipant[] {
  return workflow.phases.flatMap((phase) =>
    phase.type === "multi-agent" && phase.deliberation ? phase.deliberation.participants : [],
  );
}

export const DiscussionRolesPicker = memo(function DiscussionRolesPicker(props: {
  threadId: ThreadId;
  workflowId: WorkflowId;
  providers?: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  compact?: boolean;
  disabled?: boolean;
}) {
  const workflowQuery = useWorkflow(props.workflowId);
  const workflow = workflowQuery.data;
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(props.threadId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const roleOverrides = draftThread?.discussionRoleModels ?? null;

  const participants = useMemo(
    () => (workflow ? collectDiscussionParticipants(workflow) : []),
    [workflow],
  );

  const handleRoleModelChange = (role: string, provider: ProviderKind, model: string) => {
    const next: Record<string, ModelSelection> = { ...roleOverrides };
    next[role] = { provider, model } as ModelSelection;
    setDraftThreadContext(props.threadId, { discussionRoleModels: next });
  };

  if (participants.length === 0) return null;

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className={cn(
              "shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3",
            )}
            disabled={props.disabled}
          />
        }
      >
        <UsersIcon aria-hidden="true" className="size-4 shrink-0" />
        <span className="sr-only sm:not-sr-only">Roles</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-56">
        {participants.map((participant) => (
          <RoleModelSubMenu
            key={participant.role}
            role={participant.role}
            defaultModel={participant.agent.model ?? null}
            activeModel={roleOverrides?.[participant.role] ?? participant.agent.model ?? null}
            providers={props.providers}
            modelOptionsByProvider={props.modelOptionsByProvider}
            onModelChange={(provider, model) =>
              handleRoleModelChange(participant.role, provider, model)
            }
          />
        ))}
      </MenuPopup>
    </Menu>
  );
});

function RoleModelSubMenu(props: {
  role: string;
  defaultModel: ModelSelection | null;
  activeModel: ModelSelection | null;
  providers: ReadonlyArray<ServerProvider> | undefined;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  onModelChange: (provider: ProviderKind, model: string) => void;
}) {
  const activeModelLabel = props.activeModel
    ? (props.modelOptionsByProvider[props.activeModel.provider]?.find(
        (o) => o.slug === props.activeModel!.model,
      )?.name ?? props.activeModel.model)
    : "Default";

  return (
    <MenuSub>
      <MenuSubTrigger>
        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
          <span className="truncate font-medium">{formatRoleLabel(props.role)}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{activeModelLabel}</span>
        </span>
      </MenuSubTrigger>
      <MenuSubPopup className="[--available-height:min(24rem,70vh)]" sideOffset={4}>
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
                    value={
                      props.activeModel?.provider === option.value ? props.activeModel.model : ""
                    }
                    onValueChange={(value) => props.onModelChange(option.value, value)}
                  >
                    {props.modelOptionsByProvider[option.value].map((modelOption) => (
                      <MenuRadioItem
                        key={`${option.value}:${modelOption.slug}`}
                        value={modelOption.slug}
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
      </MenuSubPopup>
    </MenuSub>
  );
}
