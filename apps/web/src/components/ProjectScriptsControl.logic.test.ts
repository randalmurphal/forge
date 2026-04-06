import { describe, expect, it } from "vitest";

import {
  keybindingFromProjectScriptShortcutEvent,
  normalizeProjectScriptShortcutKeyToken,
} from "./ProjectScriptsControl.logic";

describe("ProjectScriptsControl.logic", () => {
  it("normalizes supported special keys for captured shortcuts", () => {
    expect(normalizeProjectScriptShortcutKeyToken(" ")).toBe("space");
    expect(normalizeProjectScriptShortcutKeyToken("Escape")).toBe("esc");
    expect(normalizeProjectScriptShortcutKeyToken("ArrowDown")).toBe("arrowdown");
    expect(normalizeProjectScriptShortcutKeyToken("F12")).toBe("f12");
    expect(normalizeProjectScriptShortcutKeyToken("Enter")).toBe("enter");
  });

  it("ignores bare modifier keys and unsupported keys", () => {
    expect(normalizeProjectScriptShortcutKeyToken("Meta")).toBeNull();
    expect(normalizeProjectScriptShortcutKeyToken("Alt")).toBeNull();
    expect(normalizeProjectScriptShortcutKeyToken("CapsLock")).toBeNull();
  });

  it("uses mod for command on macOS and preserves ctrl separately", () => {
    expect(
      keybindingFromProjectScriptShortcutEvent({
        platform: "MacIntel",
        event: {
          key: "K",
          metaKey: true,
          ctrlKey: true,
          shiftKey: true,
        },
      }),
    ).toBe("mod+ctrl+shift+k");
  });

  it("uses mod for control on non-mac platforms and preserves meta separately", () => {
    expect(
      keybindingFromProjectScriptShortcutEvent({
        platform: "Linux x86_64",
        event: {
          key: "ArrowRight",
          ctrlKey: true,
          metaKey: true,
          altKey: true,
        },
      }),
    ).toBe("mod+meta+alt+arrowright");
  });

  it("returns null for bare keys without modifiers", () => {
    expect(
      keybindingFromProjectScriptShortcutEvent({
        platform: "MacIntel",
        event: {
          key: "k",
        },
      }),
    ).toBeNull();
  });
});
