import { describe, expect, it } from "vitest";

import {
  isWindowsCommandAvailable,
  resolveWslEditorLaunch,
  getWindowsAvailableEditors,
} from "./editorLaunch";

// ---------------------------------------------------------------------------
// resolveWslEditorLaunch — pure path translation + arg building
// ---------------------------------------------------------------------------

describe("resolveWslEditorLaunch", () => {
  const distro = "Ubuntu";

  // --- goto style (VS Code family) ---

  it("translates a bare path for a goto editor", () => {
    const result = resolveWslEditorLaunch(distro, "/home/user/project", "vscode");
    expect(result).toEqual({
      command: "code",
      args: ["\\\\wsl.localhost\\Ubuntu\\home\\user\\project"],
    });
  });

  it("translates a goto target with line and column", () => {
    const result = resolveWslEditorLaunch(distro, "/home/user/file.ts:10:5", "vscode");
    expect(result).toEqual({
      command: "code",
      args: ["--goto", "\\\\wsl.localhost\\Ubuntu\\home\\user\\file.ts:10:5"],
    });
  });

  it("translates a goto target with line only", () => {
    const result = resolveWslEditorLaunch(distro, "/home/user/file.ts:42", "vscode");
    expect(result).toEqual({
      command: "code",
      args: ["--goto", "\\\\wsl.localhost\\Ubuntu\\home\\user\\file.ts:42"],
    });
  });

  it("works for cursor editor", () => {
    const result = resolveWslEditorLaunch(distro, "/home/user/project", "cursor");
    expect(result).toEqual({
      command: "cursor",
      args: ["\\\\wsl.localhost\\Ubuntu\\home\\user\\project"],
    });
  });

  // --- direct-path style (Zed) ---

  it("translates for direct-path style editor", () => {
    const result = resolveWslEditorLaunch(distro, "/home/user/project", "zed");
    expect(result).toEqual({
      command: "zed",
      args: ["\\\\wsl.localhost\\Ubuntu\\home\\user\\project"],
    });
  });

  // --- line-column style (IntelliJ) ---

  it("translates for line-column style editor with position", () => {
    const result = resolveWslEditorLaunch(distro, "/home/user/file.ts:10:5", "idea");
    expect(result).toEqual({
      command: "idea",
      args: ["--line", "10", "--column", "5", "\\\\wsl.localhost\\Ubuntu\\home\\user\\file.ts"],
    });
  });

  it("translates for line-column style editor without position", () => {
    const result = resolveWslEditorLaunch(distro, "/home/user/project", "idea");
    expect(result).toEqual({
      command: "idea",
      args: ["\\\\wsl.localhost\\Ubuntu\\home\\user\\project"],
    });
  });

  // --- file-manager ---

  it("uses explorer.exe for file-manager", () => {
    const result = resolveWslEditorLaunch(distro, "/home/user/project", "file-manager");
    expect(result).toEqual({
      command: "explorer.exe",
      args: ["\\\\wsl.localhost\\Ubuntu\\home\\user\\project"],
    });
  });

  // --- edge cases ---

  it("returns null for unknown editor", () => {
    expect(resolveWslEditorLaunch(distro, "/home/user", "nonexistent")).toBeNull();
  });

  it("handles deeply nested paths", () => {
    const result = resolveWslEditorLaunch(
      distro,
      "/home/user/.local/share/forge/data/file.ts:1:1",
      "vscode",
    );
    expect(result).toEqual({
      command: "code",
      args: [
        "--goto",
        "\\\\wsl.localhost\\Ubuntu\\home\\user\\.local\\share\\forge\\data\\file.ts:1:1",
      ],
    });
  });

  it("handles distro names with special characters", () => {
    const result = resolveWslEditorLaunch("Ubuntu-22.04", "/home/user/project", "vscode");
    expect(result).toEqual({
      command: "code",
      args: ["\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\project"],
    });
  });
});

// ---------------------------------------------------------------------------
// isWindowsCommandAvailable — PATH scanning
// ---------------------------------------------------------------------------

describe("isWindowsCommandAvailable", () => {
  it("returns false when PATH is empty", () => {
    expect(isWindowsCommandAvailable("code", { PATH: "" })).toBe(false);
  });

  it("returns false when command is not in any PATH directory", () => {
    expect(isWindowsCommandAvailable("code", { PATH: "/nonexistent", PATHEXT: ".EXE" })).toBe(
      false,
    );
  });

  it("uses default PATHEXT fallback when not set", () => {
    // Should not throw when PATHEXT is undefined
    expect(isWindowsCommandAvailable("code", { PATH: "/nonexistent" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getWindowsAvailableEditors — integration of PATH scanning + EDITORS
// ---------------------------------------------------------------------------

describe("getWindowsAvailableEditors", () => {
  it("returns empty array when no editors are on PATH", () => {
    const result = getWindowsAvailableEditors({ PATH: "", PATHEXT: ".EXE" });
    expect(result).toEqual([]);
  });
});
