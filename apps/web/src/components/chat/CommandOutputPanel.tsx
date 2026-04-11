import { memo, useCallback, useLayoutEffect, useRef } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";

export const CommandOutputPanel = memo(function CommandOutputPanel(props: {
  output: string;
  maxHeightPx: number;
  label?: string | undefined;
  className?: string | undefined;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const scrollRef = useRef<HTMLPreElement | null>(null);
  const isAtBottomRef = useRef(true);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !isAtBottomRef.current) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [props.output]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const distanceFromBottom = element.scrollHeight - element.clientHeight - element.scrollTop;
    isAtBottomRef.current = distanceFromBottom <= 16;
  }, []);

  return (
    <div
      data-command-output-panel="true"
      className={props.className ?? "rounded-lg border border-border/35 bg-background/35"}
    >
      <div className="flex items-center justify-between gap-2 border-border/20 border-b px-3 py-2">
        <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
          {props.label ?? "Output"}
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="h-5 px-1.5 text-[10px] text-muted-foreground/60"
          onClick={() => copyToClipboard(props.output, undefined)}
        >
          {isCopied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre
        ref={scrollRef}
        onScroll={onScroll}
        className="overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-[1.5] text-foreground/75 [scrollbar-width:thin]"
        style={{ maxHeight: props.maxHeightPx }}
      >
        {props.output}
      </pre>
    </div>
  );
});
