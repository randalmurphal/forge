import type { ModelSelection, ProviderKind, ServerProvider, ThreadId } from "@forgetools/contracts";
import { memo, useCallback, useState } from "react";
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
import { useSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { resolveProviderAccentColor } from "~/lib/appearance";

const STORAGE_KEY = "forge:summary-model";

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

function loadStickyModel(): ModelSelection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.provider === "string" && typeof parsed.model === "string") {
      return parsed as ModelSelection;
    }
  } catch {
    // Ignore invalid stored data.
  }
  return null;
}

function saveStickyModel(selection: ModelSelection): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
}

export const SummarizeButton = memo(function SummarizeButton(props: {
  threadId: ThreadId;
  providers?: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  disabled?: boolean;
}) {
  const [stickyModel, setStickyModel] = useState<ModelSelection | null>(loadStickyModel);
  const settings = useSettings((current) => current);
  const { resolvedTheme } = useTheme();
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

  const dispatchSummary = useCallback(
    (selection: ModelSelection) => {
      const api = readNativeApi();
      if (!api) return;
      void api.orchestration.dispatchCommand({
        type: "thread.summary.request",
        commandId: newCommandId(),
        threadId: props.threadId,
        modelSelection: selection,
        createdAt: new Date().toISOString(),
      });
    },
    [props.threadId],
  );

  const handleModelSelect = useCallback((provider: ProviderKind, model: string) => {
    const selection = { provider, model } as ModelSelection;
    setStickyModel(selection);
    saveStickyModel(selection);
    setIsMenuOpen(false);
  }, []);

  const handleDirectClick = useCallback(() => {
    if (!stickyModel) return;
    dispatchSummary(stickyModel);
  }, [stickyModel, dispatchSummary]);

  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <div className="flex items-center">
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0 rounded-r-none whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
        disabled={props.disabled || !stickyModel}
        onClick={handleDirectClick}
      >
        <FileTextIcon aria-hidden="true" className="size-4 shrink-0" />
        <span className="sr-only sm:not-sr-only">
          Summarize
          {stickyModel ? (
            <span className="ml-1 text-muted-foreground/50">
              ·{" "}
              {props.modelOptionsByProvider[stickyModel.provider]?.find(
                (o) => o.slug === stickyModel.model,
              )?.name ?? stickyModel.model}
            </span>
          ) : null}
        </span>
      </Button>
      <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
        <MenuTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 rounded-l-none border-l border-border/40 px-1.5 text-muted-foreground/70 hover:text-foreground/80"
              disabled={props.disabled}
            />
          }
        >
          <ChevronDownIcon aria-hidden="true" className="size-3" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-56">
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
                      value={stickyModel?.provider === option.value ? stickyModel.model : ""}
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
    </div>
  );
});
