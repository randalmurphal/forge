import { afterEach, describe, expect, it, vi } from "vitest";

import { buildMarkdownClipboardPayload, writeClipboardValue } from "./clipboard";

class FakeClipboardItem {
  readonly items: Record<string, Blob>;

  constructor(items: Record<string, Blob>) {
    this.items = items;
  }
}

describe("clipboard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("prefers rich clipboard writes for markdown payloads", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: {
        write,
        writeText,
      },
    });
    vi.stubGlobal("ClipboardItem", FakeClipboardItem as unknown as typeof ClipboardItem);

    await writeClipboardValue(buildMarkdownClipboardPayload("- item one"));

    expect(write).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();

    const [clipboardItems] = write.mock.calls[0] as [FakeClipboardItem[]];
    const clipboardItem = clipboardItems[0];
    expect(clipboardItem).toBeDefined();
    expect(clipboardItem).toBeInstanceOf(FakeClipboardItem);
    expect(await clipboardItem?.items["text/plain"]?.text()).toBe("- item one");
    expect(await clipboardItem?.items["text/markdown"]?.text()).toBe("- item one");
  });

  it("falls back to writeText when rich clipboard writes are unavailable", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText,
      },
    });
    vi.stubGlobal("ClipboardItem", undefined);

    await writeClipboardValue(buildMarkdownClipboardPayload("## Heading"));

    expect(writeText).toHaveBeenCalledWith("## Heading");
  });
});
