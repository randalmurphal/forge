import { isMacPlatform } from "~/lib/utils";

export interface ProjectScriptShortcutCaptureEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export function normalizeProjectScriptShortcutKeyToken(key: string): string | null {
  const normalized = key.toLowerCase();
  if (
    normalized === "meta" ||
    normalized === "control" ||
    normalized === "ctrl" ||
    normalized === "shift" ||
    normalized === "alt" ||
    normalized === "option"
  ) {
    return null;
  }
  if (normalized === " ") return "space";
  if (normalized === "escape") return "esc";
  if (normalized === "arrowup") return "arrowup";
  if (normalized === "arrowdown") return "arrowdown";
  if (normalized === "arrowleft") return "arrowleft";
  if (normalized === "arrowright") return "arrowright";
  if (normalized.length === 1) return normalized;
  if (normalized.startsWith("f") && normalized.length <= 3) return normalized;
  if (normalized === "enter" || normalized === "tab" || normalized === "backspace") {
    return normalized;
  }
  if (normalized === "delete" || normalized === "home" || normalized === "end") {
    return normalized;
  }
  if (normalized === "pageup" || normalized === "pagedown") return normalized;
  return null;
}

export function keybindingFromProjectScriptShortcutEvent(input: {
  event: ProjectScriptShortcutCaptureEvent;
  platform: string;
}): string | null {
  const keyToken = normalizeProjectScriptShortcutKeyToken(input.event.key);
  if (!keyToken) return null;

  const parts: string[] = [];
  if (isMacPlatform(input.platform)) {
    if (input.event.metaKey) parts.push("mod");
    if (input.event.ctrlKey) parts.push("ctrl");
  } else {
    if (input.event.ctrlKey) parts.push("mod");
    if (input.event.metaKey) parts.push("meta");
  }
  if (input.event.altKey) parts.push("alt");
  if (input.event.shiftKey) parts.push("shift");
  if (parts.length === 0) {
    return null;
  }
  parts.push(keyToken);
  return parts.join("+");
}
