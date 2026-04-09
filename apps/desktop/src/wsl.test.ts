import { describe, expect, it } from "vitest";

import { parseDistroOutput, toWslUncPath } from "./wsl";

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
