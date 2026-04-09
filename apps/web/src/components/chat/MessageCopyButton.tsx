import { memo } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { buildMarkdownClipboardPayload } from "~/lib/clipboard";

export const MessageCopyButton = memo(function MessageCopyButton({
  markdown,
}: {
  markdown: string;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      onClick={() => copyToClipboard(buildMarkdownClipboardPayload(markdown))}
      title="Copy markdown"
      aria-label="Copy markdown"
    >
      {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
    </Button>
  );
});
