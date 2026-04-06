import { describe, expect, it } from "vitest";

import {
  hasExpectedDaemonSocketPath,
  hasOwnerOnlyFileMode,
  isTrustedDaemonManifest,
  OWNER_ONLY_FILE_MODE,
  parseDaemonManifest,
  stripInheritedDaemonRuntimeEnv,
  shouldRequireOwnerOnlyPermissions,
} from "./daemon";

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

  it("parses a valid daemon manifest", () => {
    expect(
      parseDaemonManifest({
        pid: 42,
        wsPort: 3773,
        wsToken: "secret-token",
        socketPath: "/Users/randy/.forge/forge.sock",
        startedAt: "2026-04-06T12:00:00.000Z",
      }),
    ).toEqual({
      pid: 42,
      wsPort: 3773,
      wsToken: "secret-token",
      socketPath: "/Users/randy/.forge/forge.sock",
      startedAt: "2026-04-06T12:00:00.000Z",
    });
  });

  it("rejects malformed daemon manifests", () => {
    expect(
      parseDaemonManifest({
        pid: 42,
        wsPort: 3773,
        wsToken: "",
        socketPath: "/Users/randy/.forge/forge.sock",
        startedAt: "2026-04-06T12:00:00.000Z",
      }),
    ).toBeUndefined();
  });

  it("rejects daemon manifests with out-of-range websocket ports", () => {
    expect(
      parseDaemonManifest({
        pid: 42,
        wsPort: 70_000,
        wsToken: "secret-token",
        socketPath: "/Users/randy/.forge/forge.sock",
        startedAt: "2026-04-06T12:00:00.000Z",
      }),
    ).toBeUndefined();
  });

  it("requires owner-only permissions on supported platforms by default", () => {
    expect(shouldRequireOwnerOnlyPermissions({ platform: "darwin" })).toBe(true);
    expect(shouldRequireOwnerOnlyPermissions({ platform: "win32" })).toBe(false);
  });

  it("validates daemon manifest trust with shared rules", () => {
    expect(
      isTrustedDaemonManifest({ socketPath: "/Users/randy/.forge/forge.sock" }, 0o600, {
        expectedSocketPath: "/Users/randy/.forge/forge.sock",
        platform: "linux",
      }),
    ).toBe(true);
    expect(
      isTrustedDaemonManifest({ socketPath: "/tmp/other.sock" }, 0o600, {
        expectedSocketPath: "/Users/randy/.forge/forge.sock",
        platform: "linux",
      }),
    ).toBe(false);
    expect(
      isTrustedDaemonManifest({ socketPath: "/Users/randy/.forge/forge.sock" }, 0o644, {
        expectedSocketPath: "/Users/randy/.forge/forge.sock",
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("strips inherited daemon runtime overrides before spawning a child daemon", () => {
    expect(
      stripInheritedDaemonRuntimeEnv({
        PATH: "/usr/bin",
        FORGE_AUTH_TOKEN: "pinned-token",
        FORGE_BOOTSTRAP_FD: "3",
        FORGE_HOST: "0.0.0.0",
        FORGE_MODE: "desktop",
        FORGE_NO_BROWSER: "1",
        FORGE_PORT: "3773",
      }),
    ).toEqual({
      PATH: "/usr/bin",
    });
  });
});
