import { ChevronDownIcon } from "lucide-react";
import { type ReactNode } from "react";

import { cn } from "~/lib/utils";

interface CompactDiffCardProps {
  header: ReactNode;
  children: ReactNode;
  className?: string;
  expanded?: boolean | undefined;
  showExpandBar?: boolean | undefined;
  onToggleExpand?: (() => void) | undefined;
  tone?: "default" | "turn" | undefined;
}

export function CompactDiffCard(props: CompactDiffCardProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border/55 bg-card/32",
        props.tone === "turn" && "bg-card/24",
        props.className,
      )}
    >
      {props.header}
      {props.children}
      {props.showExpandBar ? (
        <button
          type="button"
          className="flex h-6 w-full items-center justify-center border-t border-border/35 text-muted-foreground/45 transition-colors hover:bg-background/25 hover:text-muted-foreground/78"
          onClick={props.onToggleExpand}
          aria-label={props.expanded ? "Collapse diff preview" : "Expand diff preview"}
          data-compact-diff-expand-bar="true"
        >
          <ChevronDownIcon
            className={cn("size-3.5 transition-transform", props.expanded && "rotate-180")}
          />
        </button>
      ) : null}
    </div>
  );
}
