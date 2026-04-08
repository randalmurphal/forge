import type { ProviderKind, ServerProvider, ThreadId } from "@forgetools/contracts";
import { memo } from "react";
import { type ProviderPickerKind, PROVIDER_OPTIONS } from "../../session-logic";
import { ChevronDownIcon, FileTextIcon } from "lucide-react";
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
import { cn, newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { getProviderSnapshot } from "../../providerModels";

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

export const SummarizeButton = memo(function SummarizeButton(props: {
  threadId: ThreadId;
  providers?: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  disabled?: boolean;
}) {
  const handleModelSelect = (provider: ProviderKind, model: string) => {
    const api = readNativeApi();
    if (!api) return;
    void api.orchestration.dispatchCommand({
      type: "thread.summary.request",
      commandId: newCommandId(),
      threadId: props.threadId,
      modelSelection: { provider, model },
      createdAt: new Date().toISOString(),
    });
  };

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
            disabled={props.disabled}
          />
        }
      >
        <FileTextIcon aria-hidden="true" className="size-4 shrink-0" />
        <span className="sr-only sm:not-sr-only">Summarize</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-56">
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
                    value=""
                    onValueChange={(value) => handleModelSelect(option.value, value)}
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
      </MenuPopup>
    </Menu>
  );
});
