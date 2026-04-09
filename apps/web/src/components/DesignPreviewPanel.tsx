import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MonitorIcon, SmartphoneIcon, TabletIcon, PaletteIcon } from "lucide-react";

import { InteractiveRequestId, type ThreadId } from "@forgetools/contracts";

import { cn, newThreadId, resolveServerUrl } from "~/lib/utils";
import { useThreadById } from "~/storeSelectors";
import { useComposerDraftStore } from "~/composerDraftStore";
import { getWsRpcClient } from "~/wsRpcClient";
import type { DesignArtifact, DesignPendingOptions } from "~/types";

import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { Button } from "./ui/button";
import { Select, SelectTrigger, SelectPopup, SelectItem } from "./ui/select";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";

// ── Types ────────────────────────────────────────────────────────────

interface DesignPreviewPanelProps {
  mode: DiffPanelMode;
  threadId: ThreadId;
}

type ViewportSize = "mobile" | "tablet" | "desktop";

const VIEWPORT_MAX_WIDTHS: Record<ViewportSize, string | null> = {
  mobile: "375px",
  tablet: "768px",
  desktop: null,
};

const EMPTY_ARTIFACTS: DesignArtifact[] = [];

// ── Helpers ──────────────────────────────────────────────────────────

function buildArtifactUrl(threadId: ThreadId, artifactId: string): string {
  return resolveServerUrl({
    protocol: window.location.protocol === "https:" ? "https" : "http",
    pathname: `/api/internal/design/artifacts/${threadId}/${artifactId}.html`,
  });
}

// ── Sub-components ───────────────────────────────────────────────────

const ViewportButton = memo(function ViewportButton(props: {
  size: ViewportSize;
  activeSize: ViewportSize;
  onClick: (size: ViewportSize) => void;
  icon: React.ReactNode;
  label: string;
}) {
  const isActive = props.size === props.activeSize;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(isActive && "bg-accent text-accent-foreground")}
            onClick={() => props.onClick(props.size)}
            aria-pressed={isActive}
          />
        }
      >
        {props.icon}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
});

const OptionsPicker = memo(function OptionsPicker(props: {
  pendingOptions: DesignPendingOptions;
  selectedOptionId: string;
  onSelectOption: (optionId: string) => void;
  onChooseOption: () => void;
  isSubmitting: boolean;
}) {
  const { pendingOptions, selectedOptionId, onSelectOption, onChooseOption, isSubmitting } = props;
  const selectedOption = pendingOptions.options.find((opt) => opt.id === selectedOptionId);

  return (
    <div className="flex flex-col gap-2 border-t border-border p-3">
      <div className="flex flex-wrap gap-1">
        {pendingOptions.options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              option.id === selectedOptionId
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
            onClick={() => onSelectOption(option.id)}
          >
            {option.title}
          </button>
        ))}
      </div>
      {selectedOption ? (
        <p className="text-xs text-muted-foreground">{selectedOption.description}</p>
      ) : null}
      <Button size="sm" onClick={onChooseOption} disabled={isSubmitting}>
        {isSubmitting ? "Choosing..." : "Choose this option"}
      </Button>
    </div>
  );
});

const EmptyState = memo(function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl bg-muted">
        <PaletteIcon className="size-6 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">No design preview yet</p>
        <p className="text-xs text-muted-foreground">
          Design preview will appear here when the agent renders a mockup.
        </p>
      </div>
    </div>
  );
});

// ── Main Component ───────────────────────────────────────────────────

const DesignPreviewPanel = memo(function DesignPreviewPanel(props: DesignPreviewPanelProps) {
  const { mode, threadId } = props;
  const thread = useThreadById(threadId);
  const navigate = useNavigate();

  // Fetch persisted artifacts from the server (survives page refresh)
  const [serverArtifacts, setServerArtifacts] = useState<DesignArtifact[]>([]);
  useEffect(() => {
    const listUrl = resolveServerUrl({
      protocol: window.location.protocol === "https:" ? "https" : "http",
      pathname: `/api/internal/design/artifact-list/${threadId}`,
    });
    fetch(listUrl)
      .then((res) => res.json())
      .then((data: { artifacts?: DesignArtifact[] }) => {
        if (data.artifacts && data.artifacts.length > 0) {
          setServerArtifacts(data.artifacts);
        }
      })
      .catch(() => {
        // Silently ignore — artifacts just won't appear until a new one is rendered
      });
  }, [threadId]);

  // Merge server-persisted artifacts with real-time store artifacts, dedup by ID
  const storeArtifacts = thread?.designArtifacts ?? EMPTY_ARTIFACTS;
  const artifacts = useMemo(() => {
    const byId = new Map<string, DesignArtifact>();
    for (const a of serverArtifacts) byId.set(a.artifactId, a);
    for (const a of storeArtifacts) byId.set(a.artifactId, a);
    return Array.from(byId.values()).toSorted(
      (a, b) => new Date(a.renderedAt).getTime() - new Date(b.renderedAt).getTime(),
    );
  }, [serverArtifacts, storeArtifacts]);

  const pendingOptions = thread?.designPendingOptions ?? null;
  const showOptionsPicker = pendingOptions !== null && pendingOptions.chosenOptionId === null;

  // The active artifact is the latest by default, or overridden by dropdown/option selection
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState<ViewportSize>("desktop");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // When pending options are shown and no artifact is manually selected,
  // default to the first option's artifact
  const activeOptionId = useMemo(() => {
    if (!showOptionsPicker || !pendingOptions) return null;
    return pendingOptions.options[0]?.id ?? null;
  }, [showOptionsPicker, pendingOptions]);

  const [selectedPendingOptionId, setSelectedPendingOptionId] = useState<string | null>(null);
  const effectiveOptionId = selectedPendingOptionId ?? activeOptionId;

  const resolvedArtifactId = useMemo(() => {
    // If there are pending options and the user is picking between them,
    // use the selected option's artifact
    if (showOptionsPicker && effectiveOptionId && pendingOptions) {
      const option = pendingOptions.options.find((opt) => opt.id === effectiveOptionId);
      if (option) return option.artifactId;
    }
    // Otherwise use the manually selected artifact or fall back to the latest
    if (selectedArtifactId) return selectedArtifactId;
    if (artifacts.length > 0) return artifacts[artifacts.length - 1]!.artifactId;
    return null;
  }, [showOptionsPicker, effectiveOptionId, pendingOptions, selectedArtifactId, artifacts]);

  const activeArtifact = useMemo(
    () => artifacts.find((a) => a.artifactId === resolvedArtifactId) ?? null,
    [artifacts, resolvedArtifactId],
  );

  const iframeSrc = useMemo(
    () => (resolvedArtifactId ? buildArtifactUrl(threadId, resolvedArtifactId) : null),
    [threadId, resolvedArtifactId],
  );

  const maxWidth = VIEWPORT_MAX_WIDTHS[viewportSize];

  const handleChooseOption = useCallback(async () => {
    if (!pendingOptions || !effectiveOptionId) return;
    const option = pendingOptions.options.find((opt) => opt.id === effectiveOptionId);
    if (!option) return;

    setIsSubmitting(true);
    try {
      const rpcClient = getWsRpcClient();
      await rpcClient.request.resolve({
        requestId: InteractiveRequestId.makeUnsafe(pendingOptions.requestId),
        resolvedWith: {
          chosenOptionId: option.id,
        },
      });
    } catch (err: unknown) {
      console.error("Failed to choose design option:", err);
    } finally {
      setIsSubmitting(false);
    }
  }, [pendingOptions, effectiveOptionId]);

  const [isExporting, setIsExporting] = useState(false);

  const handleImplementThis = useCallback(async () => {
    if (!activeArtifact || !thread) return;

    setIsExporting(true);
    try {
      // Capture a screenshot of the rendered design before export
      let screenshotPath: string | null = null;
      try {
        const screenshotUrl = resolveServerUrl({
          protocol: window.location.protocol === "https:" ? "https" : "http",
          pathname: `/api/internal/design/artifacts/${threadId}/${activeArtifact.artifactId}/screenshot`,
        });
        const response = await fetch(screenshotUrl, { method: "POST" });
        const result = (await response.json()) as { screenshotPath?: string | null };
        screenshotPath = result.screenshotPath ?? null;
      } catch (err: unknown) {
        console.warn("Screenshot capture failed, exporting without screenshot:", err);
      }

      const projectId = thread.projectId;
      const nextThreadId = newThreadId();
      const { setProjectDraftThreadId, setPrompt, applyStickyState } =
        useComposerDraftStore.getState();

      setProjectDraftThreadId(projectId, nextThreadId, {
        createdAt: new Date().toISOString(),
      });
      applyStickyState(nextThreadId);
      setPrompt(
        nextThreadId,
        `\n\n---\nDesign reference: ${activeArtifact.title}\nArtifact: ${activeArtifact.artifactPath}${screenshotPath ? `\nScreenshot: ${screenshotPath}` : ""}`,
      );

      await navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
      });
    } catch (err: unknown) {
      console.error("Failed to export design:", err);
    } finally {
      setIsExporting(false);
    }
  }, [activeArtifact, thread, threadId, navigate]);

  const handleSelectOption = useCallback((optionId: string) => {
    setSelectedPendingOptionId(optionId);
  }, []);

  const handleArtifactChange = useCallback((artifactId: string | null) => {
    if (artifactId === null) return;
    setSelectedArtifactId(artifactId);
    // Clear option selection when manually browsing artifacts
    setSelectedPendingOptionId(null);
  }, []);

  // ── Header ──────────────────────────────────────────────────────────

  const header = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {artifacts.length > 1 ? (
          <Select value={resolvedArtifactId ?? undefined} onValueChange={handleArtifactChange}>
            <SelectTrigger variant="ghost" size="xs" className="max-w-48">
              <span className="truncate">{activeArtifact?.title ?? "Select artifact"}</span>
            </SelectTrigger>
            <SelectPopup>
              {artifacts.map((artifact) => (
                <SelectItem key={artifact.artifactId} value={artifact.artifactId}>
                  {artifact.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : (
          <span className="truncate text-sm font-medium">
            {activeArtifact?.title ?? "Design Preview"}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <ViewportButton
          size="mobile"
          activeSize={viewportSize}
          onClick={setViewportSize}
          icon={<SmartphoneIcon />}
          label="Mobile (375px)"
        />
        <ViewportButton
          size="tablet"
          activeSize={viewportSize}
          onClick={setViewportSize}
          icon={<TabletIcon />}
          label="Tablet (768px)"
        />
        <ViewportButton
          size="desktop"
          activeSize={viewportSize}
          onClick={setViewportSize}
          icon={<MonitorIcon />}
          label="Desktop (100%)"
        />
        {activeArtifact ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={handleImplementThis}
            disabled={isExporting}
            className="ml-1"
          >
            {isExporting ? "Exporting..." : "Export to thread"}
          </Button>
        ) : null}
      </div>
    </>
  );

  // ── Body ────────────────────────────────────────────────────────────

  if (artifacts.length === 0 && !showOptionsPicker) {
    return (
      <DiffPanelShell mode={mode} header={header}>
        <EmptyState />
      </DiffPanelShell>
    );
  }

  return (
    <DiffPanelShell mode={mode} header={header}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-muted/30 p-2">
          {iframeSrc ? (
            <iframe
              key={iframeSrc}
              src={iframeSrc}
              sandbox="allow-scripts"
              title={activeArtifact?.title ?? "Design preview"}
              className="h-full rounded-md border border-border bg-white"
              style={{
                width: maxWidth ?? "100%",
                maxWidth: maxWidth ?? "100%",
              }}
            />
          ) : null}
        </div>
        {showOptionsPicker && pendingOptions && effectiveOptionId ? (
          <OptionsPicker
            pendingOptions={pendingOptions}
            selectedOptionId={effectiveOptionId}
            onSelectOption={handleSelectOption}
            onChooseOption={handleChooseOption}
            isSubmitting={isSubmitting}
          />
        ) : null}
      </div>
    </DiffPanelShell>
  );
});

export default DesignPreviewPanel;
