import { Virtualizer } from "@pierre/diffs/react";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import { ExternalLinkIcon, SquarePenIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import {
  buildCompactDiffPreviewFromFiles,
  buildFileDiffRenderKey,
  resolveFileDiffPath,
  summarizeFileDiff,
} from "~/lib/diffRendering";

import { CompactDiffCard } from "./diff/CompactDiffCard";
import { CompactDiffEntryRow } from "./diff/CompactDiffEntryRow";
import { CompactDiffHeader } from "./diff/CompactDiffHeader";
import { CompactDiffPreview } from "./diff/CompactDiffPreview";
import { Button } from "./ui/button";

type DiffRenderMode = "stacked" | "split";

interface CollapsibleFileDiffListProps {
  files: ReadonlyArray<FileDiffMetadata>;
  resolvedTheme: "light" | "dark";
  diffRenderMode: DiffRenderMode;
  diffWordWrap: boolean;
  selectedFilePath?: string | null;
  onOpenFile?: (filePath: string) => void;
  virtualized?: boolean;
  className?: string;
  defaultExpandMode?: "all" | "selected-only" | "none";
  confirmExpandAll?: boolean;
}

function buildExpandedState(
  files: ReadonlyArray<{ key: string; path: string }>,
  selectedFilePath?: string | null,
  defaultExpandMode: "all" | "selected-only" | "none" = "none",
) {
  const state: Record<string, boolean> = {};
  for (const file of files) {
    state[file.key] = defaultExpandMode === "all";
    if (
      defaultExpandMode === "selected-only" &&
      selectedFilePath &&
      file.path === selectedFilePath
    ) {
      state[file.key] = true;
    }
  }
  return state;
}

function CollapsibleFileDiffRow(props: {
  fileDiff: FileDiffMetadata;
  expanded: boolean;
  diffRenderMode: DiffRenderMode;
  diffWordWrap: boolean;
  onToggle: () => void;
  onOpenFile?: (filePath: string) => void;
}) {
  const filePath = resolveFileDiffPath(props.fileDiff);
  const stats = summarizeFileDiff(props.fileDiff);
  const previewContent = useMemo(
    () => buildCompactDiffPreviewFromFiles([props.fileDiff]),
    [props.fileDiff],
  );
  const showExpandBar = previewContent !== null;
  const openFileAction = props.onOpenFile ? (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      className="rounded-md border border-border/45 bg-background/24 text-muted-foreground/60 hover:bg-background/40 hover:text-foreground/80"
      onClick={() => props.onOpenFile?.(filePath)}
      aria-label={`Open ${filePath} in editor`}
      title="Open in editor"
    >
      <ExternalLinkIcon className="size-3.5" />
    </Button>
  ) : null;

  return (
    <section data-diff-file-path={filePath} className="rounded-lg">
      <CompactDiffEntryRow
        icon={SquarePenIcon}
        label="FileChange"
        path={filePath}
        onClick={props.onToggle}
      />
      <CompactDiffCard
        header={
          <CompactDiffHeader
            label="File changes"
            fileCount={1}
            additions={stats.additions}
            deletions={stats.deletions}
            actions={openFileAction}
          />
        }
        expanded={props.expanded}
        showExpandBar={showExpandBar}
        onToggleExpand={props.onToggle}
      >
        {props.expanded ? (
          <CompactDiffPreview
            content={previewContent}
            expanded={true}
            collapsedBehavior="hidden"
            renderMode={props.diffRenderMode}
            wordWrap={props.diffWordWrap}
            emptyLabel="No preview available for this file."
          />
        ) : (
          <CompactDiffPreview
            content={previewContent}
            expanded={false}
            collapsedBehavior="hidden"
            renderMode={props.diffRenderMode}
            wordWrap={props.diffWordWrap}
            emptyLabel="No preview available for this file."
          />
        )}
      </CompactDiffCard>
    </section>
  );
}

export function CollapsibleFileDiffList(props: CollapsibleFileDiffListProps) {
  const { files, selectedFilePath, defaultExpandMode = "none" } = props;
  const fileEntries = useMemo(
    () =>
      files.map((file) => ({
        key: buildFileDiffRenderKey(file),
        path: resolveFileDiffPath(file),
      })),
    [files],
  );
  const [expandedByFileKey, setExpandedByFileKey] = useState<Record<string, boolean>>(() =>
    buildExpandedState(fileEntries, selectedFilePath, defaultExpandMode),
  );

  const selectedFileKey = useMemo(() => {
    if (!selectedFilePath) {
      return null;
    }
    return fileEntries.find((file) => file.path === selectedFilePath)?.key ?? null;
  }, [fileEntries, selectedFilePath]);

  useEffect(() => {
    setExpandedByFileKey(buildExpandedState(fileEntries, selectedFilePath, defaultExpandMode));
  }, [defaultExpandMode, fileEntries, selectedFilePath]);

  useEffect(() => {
    if (!selectedFileKey) return;
    if (defaultExpandMode !== "selected-only") return;
    setExpandedByFileKey((current) =>
      current[selectedFileKey] ? current : { ...current, [selectedFileKey]: true },
    );
  }, [defaultExpandMode, selectedFileKey]);

  const allExpanded =
    files.length > 0 && files.every((file) => expandedByFileKey[buildFileDiffRenderKey(file)]);
  const anyExpanded = files.some((file) => expandedByFileKey[buildFileDiffRenderKey(file)]);

  const controls = (
    <div className="flex items-center justify-end gap-1 px-1">
      <Button
        type="button"
        size="xs"
        variant="ghost"
        onClick={() => {
          if (
            props.confirmExpandAll &&
            typeof window !== "undefined" &&
            typeof window.confirm === "function" &&
            !window.confirm("This diff is large. Expanding all files may be slow. Continue?")
          ) {
            return;
          }
          setExpandedByFileKey(
            Object.fromEntries(files.map((file) => [buildFileDiffRenderKey(file), true])),
          );
        }}
        disabled={allExpanded}
      >
        Expand all
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        onClick={() =>
          setExpandedByFileKey(
            Object.fromEntries(files.map((file) => [buildFileDiffRenderKey(file), false])),
          )
        }
        disabled={!anyExpanded}
      >
        Collapse all
      </Button>
    </div>
  );
  const rows = files.map((fileDiff) => {
    const fileKey = buildFileDiffRenderKey(fileDiff);
    return (
      <div key={`${fileKey}:${props.resolvedTheme}`} className="mb-2 last:mb-0">
        <CollapsibleFileDiffRow
          fileDiff={fileDiff}
          expanded={expandedByFileKey[fileKey] ?? true}
          diffRenderMode={props.diffRenderMode}
          diffWordWrap={props.diffWordWrap}
          onToggle={() =>
            setExpandedByFileKey((current) => ({
              ...current,
              [fileKey]: !(current[fileKey] ?? true),
            }))
          }
          {...(props.onOpenFile ? { onOpenFile: props.onOpenFile } : {})}
        />
      </div>
    );
  });

  if (props.virtualized) {
    return (
      <div className={cn("flex h-full min-h-0 flex-col", props.className)}>
        <div className="px-2 pb-2">{controls}</div>
        <Virtualizer
          className="min-h-0 flex-1 overflow-auto px-2 pb-2"
          config={{
            overscrollSize: 600,
            intersectionObserverMargin: 1200,
          }}
        >
          {rows}
        </Virtualizer>
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", props.className)}>
      {controls}
      <div>{rows}</div>
    </div>
  );
}
