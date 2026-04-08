import { memo } from "react";
import { FileTextIcon } from "lucide-react";
import ChatMarkdown from "../ChatMarkdown";
import { MessageCopyButton } from "./MessageCopyButton";
import { Badge } from "../ui/badge";

export const SummaryCard = memo(function SummaryCard({
  text,
  model,
  cwd,
  isStreaming,
}: {
  text: string;
  model: string;
  cwd: string | undefined;
  isStreaming: boolean;
}) {
  return (
    <div className="rounded-[24px] border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">
            <FileTextIcon aria-hidden="true" className="size-3" />
            Summary
          </Badge>
          <p className="truncate text-[11px] text-muted-foreground">{model}</p>
        </div>
        {!isStreaming && text.length > 0 ? <MessageCopyButton text={text} /> : null}
      </div>
      <div className="mt-4">
        <ChatMarkdown text={text} cwd={cwd} isStreaming={isStreaming} />
      </div>
    </div>
  );
});
