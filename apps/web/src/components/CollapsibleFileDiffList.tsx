import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import {
  buildFileDiffRenderKey,
  DIFF_RENDER_UNSAFE_CSS,
  resolveDiffThemeName,
  resolveFileDiffPath,
  summarizeFileDiff,
} from "~/lib/diffRendering";

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
  defaultExpandMode?: "all" | "selected-only";
  confirmExpandAll?: boolean;
}

function buildExpandedState(
  files: ReadonlyArray<{ key: string; path: string }>,
  selectedFilePath?: string | null,
  defaultExpandMode: "all" | "selected-only" = "all",
) {
  const state: Record<string, boolean> = {};
  for (const file of files) {
    state[file.key] = defaultExpandMode === "all";
    if (selectedFilePath && file.path === selectedFilePath) {
      state[file.key] = true;
    }
  }
  return state;
}

function FileSummaryLabel(props: { additions: number; deletions: number }) {
  return (
    <>
      <span className="text-emerald-500/85">+{props.additions}</span>
      <span className="text-red-500/80">-{props.deletions}</span>
    </>
  );
}

function CollapsibleFileDiffRow(props: {
  fileDiff: FileDiffMetadata;
  expanded: boolean;
  diffRenderMode: DiffRenderMode;
  diffWordWrap: boolean;
  resolvedTheme: "light" | "dark";
  onToggle: () => void;
  onOpenFile?: (filePath: string) => void;
}) {
  const filePath = resolveFileDiffPath(props.fileDiff);
  const stats = summarizeFileDiff(props.fileDiff);
  const hasRename = props.fileDiff.prevName && props.fileDiff.prevName !== props.fileDiff.name;

  return (
    <section
      data-diff-file-path={filePath}
      className="overflow-hidden rounded-md border border-border/65 bg-card/55"
    >
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1.5">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-expanded={props.expanded}
          aria-label={`${props.expanded ? "Collapse" : "Expand"} ${filePath}`}
          onClick={props.onToggle}
        >
          {props.expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </Button>
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={props.onToggle}
          aria-expanded={props.expanded}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-[11px] text-foreground/90" title={filePath}>
              {filePath}
            </span>
            {hasRename ? (
              <span className="shrink-0 rounded border border-border/60 bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground/70">
                rename
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground/70">
            <FileSummaryLabel additions={stats.additions} deletions={stats.deletions} />
            <span className="capitalize">{props.fileDiff.type.replaceAll("-", " ")}</span>
          </div>
        </button>
        {props.onOpenFile ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="shrink-0"
            onClick={() => props.onOpenFile?.(filePath)}
            aria-label={`Open ${filePath} in editor`}
            title="Open in editor"
          >
            <ExternalLinkIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {props.expanded ? (
        <div className="p-1.5">
          <FileDiff
            fileDiff={props.fileDiff}
            options={{
              diffStyle: props.diffRenderMode === "split" ? "split" : "unified",
              lineDiffType: "none",
              overflow: props.diffWordWrap ? "wrap" : "scroll",
              disableFileHeader: true,
              theme: resolveDiffThemeName(props.resolvedTheme),
              themeType: props.resolvedTheme,
              unsafeCSS: DIFF_RENDER_UNSAFE_CSS,
            }}
          />
        </div>
      ) : null}
    </section>
  );
}

export function CollapsibleFileDiffList(props: CollapsibleFileDiffListProps) {
  const { files, selectedFilePath, defaultExpandMode = "all" } = props;
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
    setExpandedByFileKey((current) =>
      current[selectedFileKey] ? current : { ...current, [selectedFileKey]: true },
    );
  }, [selectedFileKey]);

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
          resolvedTheme={props.resolvedTheme}
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
