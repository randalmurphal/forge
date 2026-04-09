import { describe, expect, it } from "vitest";

import { parseDistroOutput, toWslUncPath, windowsToWslPath } from "./wsl";

// ---------------------------------------------------------------------------
// toWslUncPath — pure function, no mocks needed
// ---------------------------------------------------------------------------

describe("toWslUncPath", () => {
  it("converts a Linux home path to a Windows UNC path", () => {
    expect(toWslUncPath("Ubuntu", "/home/user/.forge")).toBe(
      "\\\\wsl.localhost\\Ubuntu\\home\\user\\.forge",
    );
  });

  it("converts a root path", () => {
    expect(toWslUncPath("Debian", "/")).toBe("\\\\wsl.localhost\\Debian\\");
  });

  it("handles deeply nested paths", () => {
    expect(toWslUncPath("Ubuntu", "/home/user/.local/share/forge/data")).toBe(
      "\\\\wsl.localhost\\Ubuntu\\home\\user\\.local\\share\\forge\\data",
    );
  });

  it("handles distro names with spaces or special characters", () => {
    expect(toWslUncPath("Ubuntu-22.04", "/home/user")).toBe(
      "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user",
    );
  });
});

// ---------------------------------------------------------------------------
// windowsToWslPath — reverse of toWslUncPath, plus drive-letter translation
// ---------------------------------------------------------------------------

describe("windowsToWslPath", () => {
  // --- Category A: WSL UNC paths ---

  it("converts a wsl.localhost UNC path to a Linux path", () => {
    expect(windowsToWslPath("\\\\wsl.localhost\\Ubuntu\\home\\user\\project", "Ubuntu")).toBe(
      "/home/user/project",
    );
  });

  it("converts a wsl$ UNC path to a Linux path", () => {
    expect(windowsToWslPath("\\\\wsl$\\Ubuntu\\home\\user\\project", "Ubuntu")).toBe(
      "/home/user/project",
    );
  });

  it("handles case-insensitive wsl.localhost prefix", () => {
    expect(windowsToWslPath("\\\\WSL.LOCALHOST\\Ubuntu\\home\\user", "Ubuntu")).toBe("/home/user");
  });

  it("handles distro root selection (no trailing path)", () => {
    expect(windowsToWslPath("\\\\wsl.localhost\\Ubuntu", "Ubuntu")).toBe("/");
  });

  it("handles distro root selection (trailing backslash)", () => {
    expect(windowsToWslPath("\\\\wsl.localhost\\Ubuntu\\", "Ubuntu")).toBe("/");
  });

  it("handles distro names with hyphens and dots", () => {
    expect(windowsToWslPath("\\\\wsl.localhost\\Ubuntu-22.04\\home\\user", "Ubuntu-22.04")).toBe(
      "/home/user",
    );
  });

  it("returns unchanged on distro mismatch", () => {
    const path = "\\\\wsl.localhost\\Debian\\home\\user";
    expect(windowsToWslPath(path, "Ubuntu")).toBe(path);
  });

  it("handles case-insensitive distro matching", () => {
    expect(windowsToWslPath("\\\\wsl.localhost\\ubuntu\\home\\user", "Ubuntu")).toBe("/home/user");
  });

  it("handles forward-slash UNC variant", () => {
    expect(windowsToWslPath("//wsl.localhost/Ubuntu/home/user/project", "Ubuntu")).toBe(
      "/home/user/project",
    );
  });

  // --- Category B: Windows drive paths ---

  it("converts an uppercase drive letter path", () => {
    expect(windowsToWslPath("C:\\Users\\rmurphy\\project", "Ubuntu")).toBe(
      "/mnt/c/Users/rmurphy/project",
    );
  });

  it("converts a lowercase drive letter path", () => {
    expect(windowsToWslPath("c:\\already\\lower", "Ubuntu")).toBe("/mnt/c/already/lower");
  });

  it("converts a different drive letter", () => {
    expect(windowsToWslPath("D:\\code", "Ubuntu")).toBe("/mnt/d/code");
  });

  it("converts a drive root path", () => {
    expect(windowsToWslPath("C:\\", "Ubuntu")).toBe("/mnt/c/");
  });

  it("handles forward-slash drive paths", () => {
    expect(windowsToWslPath("C:/Users/rmurphy/project", "Ubuntu")).toBe(
      "/mnt/c/Users/rmurphy/project",
    );
  });

  // --- Category C: Passthrough ---

  it("passes through an already-Linux path", () => {
    expect(windowsToWslPath("/home/user/project", "Ubuntu")).toBe("/home/user/project");
  });

  it("passes through a non-WSL UNC path", () => {
    const path = "\\\\server\\share\\folder";
    expect(windowsToWslPath(path, "Ubuntu")).toBe(path);
  });

  it("passes through an empty string", () => {
    expect(windowsToWslPath("", "Ubuntu")).toBe("");
  });

  // --- Roundtrip ---

  it("roundtrips with toWslUncPath for standard paths", () => {
    const paths = ["/home/user/project", "/", "/home/user/.local/share/forge/data"];
    for (const linuxPath of paths) {
      const windowsPath = toWslUncPath("Ubuntu", linuxPath);
      expect(windowsToWslPath(windowsPath, "Ubuntu")).toBe(linuxPath);
    }
  });
});

// ---------------------------------------------------------------------------
// parseDistroOutput — column-offset parsing of `wsl.exe -l -v` output
// ---------------------------------------------------------------------------

describe("parseDistroOutput", () => {
  it("parses standard multi-distro output with default marked by *", () => {
    const output = [
      "  NAME            STATE           VERSION",
      "* Ubuntu          Running         2",
      "  Debian          Stopped         2",
    ].join("\n");

    const result = parseDistroOutput(output);
    expect(result).toEqual([
      { name: "Ubuntu", isDefault: true, state: "Running", version: 2 },
      { name: "Debian", isDefault: false, state: "Stopped", version: 2 },
    ]);
  });

  it("handles distro names with spaces (e.g. Ubuntu 24.04 LTS)", () => {
    const output = [
      "  NAME                   STATE           VERSION",
      "* Ubuntu 24.04 LTS       Running         2",
      "  Debian                 Stopped         2",
    ].join("\n");

    const result = parseDistroOutput(output);
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe("Ubuntu 24.04 LTS");
    expect(result[0]!.isDefault).toBe(true);
    expect(result[1]!.name).toBe("Debian");
  });

  it("returns empty array when output has only header", () => {
    const output = "  NAME            STATE           VERSION";
    expect(parseDistroOutput(output)).toEqual([]);
  });

  it("returns empty array when output is empty", () => {
    expect(parseDistroOutput("")).toEqual([]);
  });

  it("returns empty array when STATE/VERSION headers are missing", () => {
    const output = "Some unexpected output\nfoo bar baz";
    expect(parseDistroOutput(output)).toEqual([]);
  });

  it("handles single distro with no default marker", () => {
    const output = [
      "  NAME            STATE           VERSION",
      "  Ubuntu          Running         2",
    ].join("\n");

    const result = parseDistroOutput(output);
    expect(result).toEqual([{ name: "Ubuntu", isDefault: false, state: "Running", version: 2 }]);
  });

  it("handles WSL version 1 distros", () => {
    const output = [
      "  NAME            STATE           VERSION",
      "  Legacy          Stopped         1",
    ].join("\n");

    const result = parseDistroOutput(output);
    expect(result[0]!.version).toBe(1);
  });

  it("skips lines that are too short to parse", () => {
    const output = [
      "  NAME            STATE           VERSION",
      "* Ubuntu          Running         2",
      "  ",
      "",
      "  Debian          Stopped         2",
    ].join("\n");

    const result = parseDistroOutput(output);
    expect(result).toHaveLength(2);
  });

  it("handles \\r\\n line endings", () => {
    const output =
      "  NAME            STATE           VERSION\r\n* Ubuntu          Running         2\r\n";
    const result = parseDistroOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("Ubuntu");
  });

  it("handles Installing state", () => {
    const output = [
      "  NAME            STATE           VERSION",
      "  Ubuntu          Installing      2",
    ].join("\n");

    const result = parseDistroOutput(output);
    expect(result[0]!.state).toBe("Installing");
  });
});
