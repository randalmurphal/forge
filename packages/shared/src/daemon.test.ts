import * as FS from "node:fs";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  hasExpectedDaemonSocketPath,
  hasOwnerOnlyFileMode,
  isForgeDaemonWsToken,
  isTrustedDaemonManifest,
  readTrustedDaemonSocketStat,
  OWNER_ONLY_FILE_MODE,
  parseDaemonManifest,
  readTrustedDaemonManifest,
  readTrustedDaemonManifestSync,
  stripInheritedDaemonRuntimeEnv,
  shouldRequireOwnerOnlyPermissions,
} from "./daemon";

const VALID_DAEMON_WS_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const tempDirs: string[] = [];

const makeTempDir = (prefix: string): string => {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const writeDaemonInfoFile = (path: string, socketPath: string, mode = 0o600): void => {
  FS.writeFileSync(
    path,
    JSON.stringify({
      pid: 42,
      wsPort: 3773,
      wsToken: VALID_DAEMON_WS_TOKEN,
      socketPath,
      startedAt: "2026-04-06T12:00:00.000Z",
    }),
    { encoding: "utf8", mode },
  );
  FS.chmodSync(path, mode);
};

const closeServer = (server: Net.Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    FS.rmSync(dir, { recursive: true, force: true });
  }
});

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
        wsToken: VALID_DAEMON_WS_TOKEN,
        socketPath: "/Users/randy/.forge/forge.sock",
        startedAt: "2026-04-06T12:00:00.000Z",
      }),
    ).toEqual({
      pid: 42,
      wsPort: 3773,
      wsToken: VALID_DAEMON_WS_TOKEN,
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
        wsToken: VALID_DAEMON_WS_TOKEN,
        socketPath: "/Users/randy/.forge/forge.sock",
        startedAt: "2026-04-06T12:00:00.000Z",
      }),
    ).toBeUndefined();
  });

  it("requires a 256-bit hex websocket token", () => {
    expect(isForgeDaemonWsToken(VALID_DAEMON_WS_TOKEN)).toBe(true);
    expect(
      parseDaemonManifest({
        pid: 42,
        wsPort: 3773,
        wsToken: "secret-token",
        socketPath: "/Users/randy/.forge/forge.sock",
        startedAt: "2026-04-06T12:00:00.000Z",
      }),
    ).toBeUndefined();
  });

  it("rejects daemon manifests whose startedAt is not a canonical ISO timestamp", () => {
    expect(
      parseDaemonManifest({
        pid: 42,
        wsPort: 3773,
        wsToken: VALID_DAEMON_WS_TOKEN,
        socketPath: "/Users/randy/.forge/forge.sock",
        startedAt: "yesterday",
      }),
    ).toBeUndefined();
    expect(
      parseDaemonManifest({
        pid: 42,
        wsPort: 3773,
        wsToken: VALID_DAEMON_WS_TOKEN,
        socketPath: "/Users/randy/.forge/forge.sock",
        startedAt: "2026-04-06T07:00:00-05:00",
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

  it("rejects symlinked daemon manifests during async reads", async () => {
    const baseDir = makeTempDir("forge-shared-daemon-manifest-link-");
    const socketPath = Path.join(baseDir, "forge.sock");
    const targetPath = Path.join(baseDir, "target-daemon.json");
    const linkPath = Path.join(baseDir, "daemon.json");

    writeDaemonInfoFile(targetPath, socketPath);
    FS.symlinkSync(targetPath, linkPath);

    await expect(
      readTrustedDaemonManifest(linkPath, {
        expectedSocketPath: socketPath,
        requireOwnerOnlyPermissions: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects symlinked daemon manifests during sync reads", () => {
    const baseDir = makeTempDir("forge-shared-daemon-manifest-sync-link-");
    const socketPath = Path.join(baseDir, "forge.sock");
    const targetPath = Path.join(baseDir, "target-daemon.json");
    const linkPath = Path.join(baseDir, "daemon.json");

    writeDaemonInfoFile(targetPath, socketPath);
    FS.symlinkSync(targetPath, linkPath);

    expect(
      readTrustedDaemonManifestSync(linkPath, {
        expectedSocketPath: socketPath,
        requireOwnerOnlyPermissions: true,
      }),
    ).toBeUndefined();
  });

  it("rejects symlinked daemon socket paths during trusted socket reads", async () => {
    const baseDir = makeTempDir("forge-shared-daemon-socket-link-");
    const targetSocketPath = Path.join(baseDir, "target.sock");
    const linkedSocketPath = Path.join(baseDir, "forge.sock");
    const server = Net.createServer();

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(targetSocketPath, () => {
        FS.chmodSync(targetSocketPath, 0o600);
        resolve();
      });
    });
    FS.symlinkSync(targetSocketPath, linkedSocketPath);

    try {
      await expect(
        readTrustedDaemonSocketStat(linkedSocketPath, {
          requireOwnerOnlyPermissions: true,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await closeServer(server);
      FS.rmSync(targetSocketPath, { force: true });
      FS.rmSync(linkedSocketPath, { force: true });
    }
  });

  it("rejects daemon socket paths whose permissions are broader than owner-only", async () => {
    const baseDir = makeTempDir("forge-shared-daemon-socket-perms-");
    const socketPath = Path.join(baseDir, "forge.sock");
    const server = Net.createServer();

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        FS.chmodSync(socketPath, 0o666);
        resolve();
      });
    });

    try {
      await expect(
        readTrustedDaemonSocketStat(socketPath, {
          requireOwnerOnlyPermissions: true,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await closeServer(server);
      FS.rmSync(socketPath, { force: true });
    }
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
