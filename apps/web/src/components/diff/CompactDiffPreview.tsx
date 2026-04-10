import { type ReactNode } from "react";
import { cn } from "~/lib/utils";
import {
  COMPACT_DIFF_EXPANDED_MAX_VISIBLE_LINES,
  type CompactDiffPreviewContent,
} from "~/lib/diffRendering";

interface CompactDiffPreviewProps {
  content: CompactDiffPreviewContent | null;
  expanded: boolean;
  emptyLabel: string;
  collapsedBehavior?: "preview" | "hidden";
  renderMode?: "stacked" | "split";
  wordWrap?: boolean;
  className?: string;
}

const COMPACT_DIFF_EXPANDED_MAX_HEIGHT_EM = COMPACT_DIFF_EXPANDED_MAX_VISIBLE_LINES * 1.6;

function CompactDiffExpandedShell(props: {
  children: ReactNode;
  scrollable: boolean;
  className?: string;
}) {
  if (!props.scrollable) {
    return <div className={props.className}>{props.children}</div>;
  }

  return (
    <div
      className={cn("overflow-y-auto overscroll-contain", props.className)}
      style={{ maxHeight: `${COMPACT_DIFF_EXPANDED_MAX_HEIGHT_EM}em` }}
      data-compact-diff-scrollable="true"
    >
      {props.children}
    </div>
  );
}

export function CompactDiffPreview(props: CompactDiffPreviewProps) {
  const collapsedBehavior = props.collapsedBehavior ?? "preview";
  const renderMode = props.renderMode ?? "stacked";
  const wordWrap = props.wordWrap ?? false;

  if (!props.content) {
    return (
      <p className="px-3 pb-3 pt-1.5 text-[11px] leading-5 text-muted-foreground/64">
        {props.emptyLabel}
      </p>
    );
  }

  if (props.content.kind === "raw") {
    const lines = props.expanded ? props.content.lines : props.content.visibleLines;
    if (!props.expanded && collapsedBehavior === "hidden") {
      return null;
    }

    const scrollable =
      props.expanded && props.content.lines.length > COMPACT_DIFF_EXPANDED_MAX_VISIBLE_LINES;
    return (
      <div className={cn("px-3 pb-3 pt-1.5", props.className)}>
        <p className="mb-1.5 text-[11px] leading-5 text-muted-foreground/64">
          {props.content.reason}
        </p>
        <div className="relative">
          <CompactDiffExpandedShell scrollable={scrollable}>
            <pre
              className={cn(
                "rounded-md border border-border/45 bg-background/35 p-2 font-mono text-[11px] leading-5 text-muted-foreground/82",
                props.expanded
                  ? wordWrap
                    ? "whitespace-pre-wrap break-words"
                    : "overflow-x-auto whitespace-pre"
                  : "overflow-hidden whitespace-pre-wrap",
              )}
            >
              {lines.join("\n")}
            </pre>
          </CompactDiffExpandedShell>
          {!props.expanded && props.content.hasOverflow ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-11 bg-linear-to-b from-transparent via-card/92 to-card" />
          ) : null}
        </div>
      </div>
    );
  }

  if (!props.expanded && collapsedBehavior === "hidden") {
    return null;
  }

  const lines = props.expanded ? props.content.lines : props.content.visibleLines;
  const scrollable =
    props.expanded && props.content.lines.length > COMPACT_DIFF_EXPANDED_MAX_VISIBLE_LINES;
  const lineTextClassName = wordWrap
    ? "whitespace-pre-wrap break-words"
    : "overflow-hidden text-ellipsis whitespace-pre";

  if (renderMode === "split" && props.expanded) {
    return (
      <CompactDiffExpandedShell scrollable={scrollable} className={cn("pt-1", props.className)}>
        <div
          className="overflow-hidden rounded-md border border-border/45 bg-background/20"
          data-compact-diff-split="true"
        >
          {props.content.hunks.map((hunk) => (
            <div key={hunk.key}>
              <div className="bg-muted/18 px-4 py-0.5 font-mono text-[10px] text-sky-200/34">
                {hunk.headerText}
              </div>
              {hunk.segments.map((segment) =>
                segment.kind === "context"
                  ? segment.lines.map((line, lineIndex) =>
                      (() => {
                        const occurrence = segment.lines
                          .slice(0, lineIndex + 1)
                          .filter((candidate) => candidate === line).length;
                        return (
                          <div
                            key={`${segment.key}:${line}:${occurrence}`}
                            className="grid grid-cols-2 border-t border-border/20 font-mono text-[11px] leading-[1.6] text-muted-foreground/42"
                          >
                            <div
                              className={cn(
                                "border-r border-border/20 px-3 py-0.5",
                                lineTextClassName,
                              )}
                            >
                              {line.length > 0 ? line : " "}
                            </div>
                            <div className={cn("px-3 py-0.5", lineTextClassName)}>
                              {line.length > 0 ? line : " "}
                            </div>
                          </div>
                        );
                      })(),
                    )
                  : (() => {
                      const rows: ReactNode[] = [];
                      const maxRows = Math.max(segment.deletions.length, segment.additions.length);
                      const occurrenceByPair = new Map<string, number>();

                      for (let rowIndex = 0; rowIndex < maxRows; rowIndex += 1) {
                        const deletion = segment.deletions[rowIndex];
                        const addition = segment.additions[rowIndex];
                        const deletionKey = deletion ?? "__empty-left__";
                        const additionKey = addition ?? "__empty-right__";
                        const pairKey = `${deletionKey}\u001f${additionKey}`;
                        const occurrence = (occurrenceByPair.get(pairKey) ?? 0) + 1;
                        occurrenceByPair.set(pairKey, occurrence);

                        rows.push(
                          <div
                            key={`${segment.key}:${deletionKey}:${additionKey}:${occurrence}`}
                            className="grid grid-cols-2 border-t border-border/20 font-mono text-[11px] leading-[1.6]"
                          >
                            <div
                              className={cn(
                                "border-r border-border/20 px-3 py-0.5",
                                deletion
                                  ? "bg-red-500/7 text-red-300/88"
                                  : "text-muted-foreground/25",
                                lineTextClassName,
                              )}
                            >
                              {deletion ?? " "}
                            </div>
                            <div
                              className={cn(
                                "px-3 py-0.5",
                                addition
                                  ? "bg-emerald-500/7 text-emerald-300/92"
                                  : "text-muted-foreground/25",
                                lineTextClassName,
                              )}
                            >
                              {addition ?? " "}
                            </div>
                          </div>,
                        );
                      }

                      return rows;
                    })(),
              )}
            </div>
          ))}
        </div>
      </CompactDiffExpandedShell>
    );
  }

  return (
    <div className={cn("relative pt-1", props.className)}>
      <CompactDiffExpandedShell scrollable={scrollable}>
        <div className="overflow-hidden pb-1 font-mono text-[11px] leading-[1.6]">
          {lines.map((line) =>
            line.kind === "hunk" ? (
              <div key={line.key} className="bg-muted/18 px-7 py-0.5 text-[10px] text-sky-200/34">
                {line.text}
              </div>
            ) : (
              <div
                key={line.key}
                className={cn(
                  "flex items-start px-3",
                  line.kind === "addition" && "bg-emerald-500/7 text-emerald-300/92",
                  line.kind === "deletion" && "bg-red-500/7 text-red-300/88",
                  line.kind === "context" && "text-muted-foreground/42",
                )}
              >
                <span
                  className={cn(
                    "w-4 shrink-0 text-center text-[10px]",
                    line.kind === "addition" && "text-emerald-300/45",
                    line.kind === "deletion" && "text-red-300/40",
                    line.kind === "context" && "text-muted-foreground/28",
                  )}
                >
                  {line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " "}
                </span>
                <span className={cn("min-w-0 flex-1 pl-1", lineTextClassName)}>
                  {line.text.length > 0 ? line.text : " "}
                </span>
              </div>
            ),
          )}
        </div>
      </CompactDiffExpandedShell>
      {!props.expanded && props.content.hasOverflow ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-11 bg-linear-to-b from-transparent via-card/92 to-card" />
      ) : null}
    </div>
  );
}
