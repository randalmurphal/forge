export interface ClipboardPayload {
  plainText: string;
  markdown?: string;
  html?: string;
}

export type ClipboardValue = string | ClipboardPayload;

export function normalizeClipboardValue(value: ClipboardValue): ClipboardPayload {
  if (typeof value === "string") {
    return { plainText: value };
  }
  return value;
}

export function buildMarkdownClipboardPayload(markdown: string): ClipboardPayload {
  return {
    plainText: markdown,
    markdown,
  };
}

export async function writeClipboardValue(value: ClipboardValue): Promise<void> {
  if (typeof navigator === "undefined" || navigator.clipboard == null) {
    throw new Error("Clipboard API unavailable.");
  }

  const payload = normalizeClipboardValue(value);
  if (!payload.plainText) {
    return;
  }

  const clipboard = navigator.clipboard as Clipboard & {
    write?: (data: ClipboardItem[]) => Promise<void>;
  };

  if (typeof clipboard.write === "function" && typeof ClipboardItem !== "undefined") {
    const items: Record<string, Blob> = {
      "text/plain": new Blob([payload.plainText], { type: "text/plain" }),
    };

    if (payload.markdown && payload.markdown.length > 0) {
      items["text/markdown"] = new Blob([payload.markdown], { type: "text/markdown" });
    }

    if (payload.html && payload.html.length > 0) {
      items["text/html"] = new Blob([payload.html], { type: "text/html" });
    }

    try {
      await clipboard.write([new ClipboardItem(items)]);
      return;
    } catch {
      // Some runtimes reject non-standard MIME types such as `text/markdown`.
      // Fall through to plain text clipboard writes when rich writes are unsupported.
    }
  }

  if (typeof clipboard.writeText === "function") {
    await clipboard.writeText(payload.plainText);
    return;
  }

  throw new Error("Clipboard API unavailable.");
}
