interface CompactDiffSummaryFallbackProps {
  files: ReadonlyArray<{ path: string }>;
  note: string;
}

export function CompactDiffSummaryFallback(props: CompactDiffSummaryFallbackProps) {
  return (
    <div className="px-3 pb-3 pt-1.5">
      <p className="text-[11px] leading-5 text-muted-foreground/64">{props.note}</p>
      {props.files.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {props.files.map((file) => (
            <span
              key={`compact-diff-summary:${file.path}`}
              className="rounded-md border border-border/50 bg-background/45 px-2 py-1 font-mono text-[10px] leading-4 text-muted-foreground/70"
              title={file.path}
            >
              {file.path}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
