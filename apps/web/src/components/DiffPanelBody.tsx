import type { FileDiffMetadata } from "@pierre/diffs/react";
import { type ReactNode, type RefObject } from "react";

import { buildCompactDiffPreviewContent, type RenderablePatch } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";

import { CompactDiffCard } from "./diff/CompactDiffCard";
import { CompactDiffHeader } from "./diff/CompactDiffHeader";
import { CompactDiffPreview } from "./diff/CompactDiffPreview";
import { CollapsibleFileDiffList } from "./CollapsibleFileDiffList";
import { Button } from "./ui/button";

type DiffRenderMode = "stacked" | "split";

interface DiffTotals {
  files: number;
  additions: number;
  deletions: number;
}

interface DiffPanelNoticeCardProps {
  title?: string;
  description: string;
  header?: ReactNode;
  actions?: ReactNode;
  tone?: "default" | "error";
  className?: string;
}

export function DiffPanelNoticeCard(props: DiffPanelNoticeCardProps) {
  return (
    <CompactDiffCard header={props.header} className={cn("w-full", props.className)}>
      <div className="px-3 py-3">
        {props.title ? (
          <p className="text-sm font-medium text-foreground/90">{props.title}</p>
        ) : null}
        <p
          className={cn(
            "text-[11px] leading-5 text-muted-foreground/72",
            props.title && "mt-1",
            props.tone === "error" && "text-red-400/86",
          )}
        >
          {props.description}
        </p>
        {props.actions ? <div className="mt-3 flex flex-wrap gap-2">{props.actions}</div> : null}
      </div>
    </CompactDiffCard>
  );
}

interface DiffPanelBodyProps {
  patchViewportRef: RefObject<HTMLDivElement | null>;
  diffSurfaceLabel: string;
  diffMode: "agent" | "workspace";
  renderablePatch: RenderablePatch | null;
  renderableFiles: FileDiffMetadata[];
  resolvedTheme: "light" | "dark";
  diffRenderMode: DiffRenderMode;
  diffWordWrap: boolean;
  selectedFilePath?: string | null;
  onOpenFile: (filePath: string) => void;
  showWorkspaceFallback: boolean;
  showDeferredRenderCard: boolean;
  onRenderDeferred: () => void;
  canRefreshWorkspace: boolean;
  onRefreshWorkspace: () => void;
  isLoadingPatch: boolean;
  loadingLabel: string;
  patchError: string | null;
  hasNoNetChanges: boolean;
  isWholeThreadNetDiffUnavailable: boolean;
  viewDiffTotals: DiffTotals | null;
  confirmExpandAll: boolean;
}

function DiffPanelStatePane(props: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-2">{props.children}</div>;
}

function buildHeader(
  label: string,
  totals: DiffTotals | null,
  actions?: ReactNode,
): ReactNode | undefined {
  if (!totals) {
    return undefined;
  }

  return (
    <CompactDiffHeader
      label={label}
      fileCount={totals.files}
      additions={totals.additions}
      deletions={totals.deletions}
      actions={actions}
    />
  );
}

export function DiffPanelBody(props: DiffPanelBodyProps) {
  const workspaceFallbackNotice = props.showWorkspaceFallback ? (
    <div className="shrink-0 px-2 pt-2">
      <DiffPanelNoticeCard description="Agent attribution is unavailable for this turn. Showing workspace changes during the turn instead." />
    </div>
  ) : null;

  if (!props.renderablePatch) {
    let stateCard: ReactNode;

    if (props.showDeferredRenderCard) {
      stateCard = (
        <DiffPanelNoticeCard
          header={buildHeader(props.diffSurfaceLabel, props.viewDiffTotals)}
          title="This diff is huge."
          description="Rich rendering is deferred to keep the UI responsive."
          actions={
            <>
              <Button size="sm" variant="outline" onClick={props.onRenderDeferred}>
                Render diff
              </Button>
              {props.canRefreshWorkspace ? (
                <Button size="sm" variant="ghost" onClick={props.onRefreshWorkspace}>
                  Refresh
                </Button>
              ) : null}
            </>
          }
          className="max-w-xl"
        />
      );
    } else if (props.isLoadingPatch) {
      stateCard = <DiffPanelNoticeCard title="Loading diff" description={props.loadingLabel} />;
    } else if (props.patchError) {
      stateCard = (
        <DiffPanelNoticeCard title="Diff unavailable" description={props.patchError} tone="error" />
      );
    } else {
      stateCard = (
        <DiffPanelNoticeCard
          title="No diff to render"
          description={
            props.isWholeThreadNetDiffUnavailable
              ? "No net diff available for this agent yet."
              : props.hasNoNetChanges
                ? props.diffMode === "workspace"
                  ? "Working tree is clean."
                  : "No net changes in this selection."
                : "No patch available for this selection."
          }
        />
      );
    }

    return (
      <div
        ref={props.patchViewportRef}
        className="diff-panel-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {workspaceFallbackNotice}
        <div className="min-h-0 flex-1">
          <DiffPanelStatePane>{stateCard}</DiffPanelStatePane>
        </div>
      </div>
    );
  }

  if (props.renderablePatch.kind === "files") {
    return (
      <div
        ref={props.patchViewportRef}
        className="diff-panel-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {workspaceFallbackNotice}
        <div className="min-h-0 flex-1">
          <CollapsibleFileDiffList
            files={props.renderableFiles}
            resolvedTheme={props.resolvedTheme}
            diffRenderMode={props.diffRenderMode}
            diffWordWrap={props.diffWordWrap}
            onOpenFile={props.onOpenFile}
            virtualized={true}
            className="diff-render-surface"
            defaultExpandMode="none"
            confirmExpandAll={props.confirmExpandAll}
            {...(props.selectedFilePath !== undefined
              ? { selectedFilePath: props.selectedFilePath }
              : {})}
          />
        </div>
      </div>
    );
  }

  const previewContent = buildCompactDiffPreviewContent(props.renderablePatch);

  return (
    <div
      ref={props.patchViewportRef}
      className="diff-panel-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {workspaceFallbackNotice}
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <CompactDiffCard
          header={buildHeader(props.diffSurfaceLabel, props.viewDiffTotals)}
          className="min-h-full"
        >
          <CompactDiffPreview
            content={previewContent}
            expanded={true}
            wordWrap={props.diffWordWrap}
            emptyLabel="No preview available for this selection."
          />
        </CompactDiffCard>
      </div>
    </div>
  );
}
