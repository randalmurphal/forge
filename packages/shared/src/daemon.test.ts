import { describe, expect, it } from "vitest";

import { hasExpectedDaemonSocketPath, hasOwnerOnlyFileMode, OWNER_ONLY_FILE_MODE } from "./daemon";

describe("daemon manifest helpers", () => {
  it("accepts owner-only file modes", () => {
    expect(hasOwnerOnlyFileMode(OWNER_ONLY_FILE_MODE)).toBe(true);
  });

  it("rejects group-readable daemon manifest modes", () => {
    expect(hasOwnerOnlyFileMode(0o640)).toBe(false);
  });

  it("matches the expected daemon socket path exactly", () => {
    expect(
      hasExpectedDaemonSocketPath(
        { socketPath: "/Users/randy/.forge/forge.sock" },
        "/Users/randy/.forge/forge.sock",
      ),
    ).toBe(true);
    expect(
      hasExpectedDaemonSocketPath(
        { socketPath: "/tmp/other.sock" },
        "/Users/randy/.forge/forge.sock",
      ),
    ).toBe(false);
  });
});
