import { type ReactNode } from "react";

import { cn } from "~/lib/utils";

interface CompactDiffHeaderProps {
  label: string;
  fileCount: number;
  additions?: number | undefined;
  deletions?: number | undefined;
  actions?: ReactNode;
  className?: string;
}

export function CompactDiffHeader(props: CompactDiffHeaderProps) {
  return (
    <div className={cn("flex items-center justify-between gap-3 px-3 py-2", props.className)}>
      <p className="min-w-0 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/62">
        <span>{props.label}</span>
        <span className="mx-1">•</span>
        <span>
          {props.fileCount} file{props.fileCount === 1 ? "" : "s"}
        </span>
        {typeof props.additions === "number" && typeof props.deletions === "number" ? (
          <>
            <span className="mx-1">•</span>
            <span className="text-emerald-400/92">+{props.additions}</span>
            <span className="mx-1 text-muted-foreground/35">/</span>
            <span className="text-red-400/88">-{props.deletions}</span>
          </>
        ) : null}
      </p>
      {props.actions ? (
        <div className="flex shrink-0 items-center gap-1.5">{props.actions}</div>
      ) : null}
    </div>
  );
}
