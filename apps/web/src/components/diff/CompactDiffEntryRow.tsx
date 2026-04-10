import { type LucideIcon } from "lucide-react";
import { type ReactNode } from "react";

import { cn } from "~/lib/utils";

interface CompactDiffEntryRowProps {
  icon: LucideIcon;
  label: string;
  path?: string | null;
  onClick?: () => void;
  action?: ReactNode;
  className?: string;
}

export function CompactDiffEntryRow(props: CompactDiffEntryRowProps) {
  const Icon = props.icon;
  const labelContent = (
    <>
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/65">
        <Icon className="size-3.5" />
      </span>
      <span className="text-[11px] leading-5 text-foreground/82">{props.label}</span>
      {props.path ? (
        <>
          <span className="text-[11px] text-muted-foreground/35">–</span>
          <span
            className="min-w-0 truncate font-mono text-[10px] leading-5 text-muted-foreground/60"
            title={props.path}
          >
            {props.path}
          </span>
        </>
      ) : null}
    </>
  );

  return (
    <div className={cn("flex items-center gap-2 px-1 py-0.5", props.className)}>
      {props.onClick ? (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={props.onClick}
        >
          {labelContent}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{labelContent}</div>
      )}
      {props.action ? <div className="shrink-0">{props.action}</div> : null}
    </div>
  );
}
