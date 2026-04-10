import { cn } from "~/lib/utils";
import { type CompactDiffPreviewContent } from "~/lib/diffRendering";

interface CompactDiffPreviewProps {
  content: CompactDiffPreviewContent | null;
  expanded: boolean;
  emptyLabel: string;
  className?: string;
}

export function CompactDiffPreview(props: CompactDiffPreviewProps) {
  if (!props.content) {
    return (
      <p className="px-3 pb-3 pt-1.5 text-[11px] leading-5 text-muted-foreground/64">
        {props.emptyLabel}
      </p>
    );
  }

  if (props.content.kind === "raw") {
    const lines = props.expanded ? props.content.lines : props.content.visibleLines;
    return (
      <div className={cn("px-3 pb-3 pt-1.5", props.className)}>
        <p className="mb-1.5 text-[11px] leading-5 text-muted-foreground/64">
          {props.content.reason}
        </p>
        <div className="relative">
          <pre className="overflow-hidden whitespace-pre-wrap rounded-md border border-border/45 bg-background/35 p-2 font-mono text-[11px] leading-5 text-muted-foreground/82">
            {lines.join("\n")}
          </pre>
          {!props.expanded && props.content.hasOverflow ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-11 bg-linear-to-b from-transparent via-card/92 to-card" />
          ) : null}
        </div>
      </div>
    );
  }

  const lines = props.expanded ? props.content.lines : props.content.visibleLines;
  return (
    <div className={cn("relative pt-1", props.className)}>
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
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-pre pl-1">
                {line.text.length > 0 ? line.text : " "}
              </span>
            </div>
          ),
        )}
      </div>
      {!props.expanded && props.content.hasOverflow ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-11 bg-linear-to-b from-transparent via-card/92 to-card" />
      ) : null}
    </div>
  );
}
