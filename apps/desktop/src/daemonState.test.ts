import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildDaemonWsUrl,
  createDesktopWsUrlResolver,
  readDaemonInfoSync,
  resolveDesktopBaseDir,
  resolveDesktopDaemonPaths,
  type DesktopDaemonInfo,
} from "./daemonState";

const VALID_DAEMON_WS_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ROTATED_DAEMON_WS_TOKEN = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const REPRIMED_DAEMON_WS_TOKEN = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const tempDirs: string[] = [];

const makeTempDir = (prefix: string): string => {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const makeDaemonInfo = (socketPath: string): DesktopDaemonInfo => ({
  pid: 42,
  wsPort: 3773,
  wsToken: VALID_DAEMON_WS_TOKEN,
  socketPath,
  startedAt: "2026-04-06T12:00:00.000Z",
});

const writeDaemonInfoFile = (path: string, daemonInfo: DesktopDaemonInfo, mode = 0o600): void => {
  FS.writeFileSync(path, JSON.stringify(daemonInfo), { encoding: "utf8", mode });
  FS.chmodSync(path, mode);
};

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    FS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveDesktopBaseDir", () => {
  it("defaults to ~/.forge when FORGE_HOME is unset", () => {
    expect(resolveDesktopBaseDir({}, "/Users/randy")).toBe("/Users/randy/.forge");
  });

  it("prefers FORGE_HOME when provided", () => {
    expect(resolveDesktopBaseDir({ FORGE_HOME: "/tmp/custom-forge" }, "/Users/randy")).toBe(
      "/tmp/custom-forge",
    );
  });
});

describe("readDaemonInfoSync", () => {
  it("reads a valid daemon.json file from the Forge base directory", () => {
    const baseDir = makeTempDir("forge-desktop-daemon-state-");
    const paths = resolveDesktopDaemonPaths(baseDir);
    const daemonInfo = makeDaemonInfo(paths.socketPath);

    writeDaemonInfoFile(paths.daemonInfoPath, daemonInfo);

    expect(readDaemonInfoSync(paths.daemonInfoPath)).toEqual(daemonInfo);
  });

  it("returns undefined for malformed daemon.json data", () => {
    const baseDir = makeTempDir("forge-desktop-daemon-invalid-");
    const paths = resolveDesktopDaemonPaths(baseDir);

    FS.writeFileSync(paths.daemonInfoPath, '{"pid":"oops"}', "utf8");

    expect(readDaemonInfoSync(paths.daemonInfoPath)).toBeUndefined();
  });

  it("rejects daemon.json when required fields are empty", () => {
    const baseDir = makeTempDir("forge-desktop-daemon-empty-fields-");
    const paths = resolveDesktopDaemonPaths(baseDir);

    FS.writeFileSync(
      paths.daemonInfoPath,
      JSON.stringify({
        pid: 42,
        wsPort: 3773,
        wsToken: "",
        socketPath: paths.socketPath,
        startedAt: "2026-04-06T12:00:00.000Z",
      }),
      "utf8",
    );

    expect(readDaemonInfoSync(paths.daemonInfoPath)).toBeUndefined();
  });

  it("rejects daemon.json when wsPort is outside the TCP port range", () => {
    const baseDir = makeTempDir("forge-desktop-daemon-invalid-port-");
    const paths = resolveDesktopDaemonPaths(baseDir);

    FS.writeFileSync(
      paths.daemonInfoPath,
      JSON.stringify({
        pid: 42,
        wsPort: 70_000,
        wsToken: VALID_DAEMON_WS_TOKEN,
        socketPath: paths.socketPath,
        startedAt: "2026-04-06T12:00:00.000Z",
      }),
      "utf8",
    );

    expect(readDaemonInfoSync(paths.daemonInfoPath)).toBeUndefined();
  });

  it("rejects daemon.json when wsToken is not a 256-bit hex token", () => {
    const baseDir = makeTempDir("forge-desktop-daemon-invalid-token-");
    const paths = resolveDesktopDaemonPaths(baseDir);

    FS.writeFileSync(
      paths.daemonInfoPath,
      JSON.stringify({
        pid: 42,
        wsPort: 3773,
        wsToken: "secret-token",
        socketPath: paths.socketPath,
        startedAt: "2026-04-06T12:00:00.000Z",
      }),
      "utf8",
    );

    expect(readDaemonInfoSync(paths.daemonInfoPath)).toBeUndefined();
  });

  it("rejects daemon.json when the manifest socket path does not match Forge's socket", () => {
    const baseDir = makeTempDir("forge-desktop-daemon-mismatch-");
    const paths = resolveDesktopDaemonPaths(baseDir);
    const daemonInfo = makeDaemonInfo("/tmp/other-daemon.sock");

    writeDaemonInfoFile(paths.daemonInfoPath, daemonInfo);

    expect(
      readDaemonInfoSync(paths.daemonInfoPath, {
        expectedSocketPath: paths.socketPath,
      }),
    ).toBeUndefined();
  });

  it("rejects daemon.json when permissions are broader than owner-only", () => {
    const baseDir = makeTempDir("forge-desktop-daemon-perms-");
    const paths = resolveDesktopDaemonPaths(baseDir);
    const daemonInfo = makeDaemonInfo(paths.socketPath);

    writeDaemonInfoFile(paths.daemonInfoPath, daemonInfo, 0o644);

    expect(readDaemonInfoSync(paths.daemonInfoPath)).toBeUndefined();
  });
});

describe("createDesktopWsUrlResolver", () => {
  it("resolves the websocket URL from an existing daemon.json file", () => {
    const baseDir = makeTempDir("forge-desktop-daemon-url-");
    const paths = resolveDesktopDaemonPaths(baseDir);
    const daemonInfo = makeDaemonInfo(paths.socketPath);

    writeDaemonInfoFile(paths.daemonInfoPath, daemonInfo);

    const resolver = createDesktopWsUrlResolver({ paths });

    expect(resolver.getWsUrl()).toBe(buildDaemonWsUrl(daemonInfo));
  });

  it("refreshes the websocket URL when daemon.json rotates after startup", () => {
    const baseDir = makeTempDir("forge-desktop-daemon-rotated-url-");
    const paths = resolveDesktopDaemonPaths(baseDir);
    const initialDaemonInfo = makeDaemonInfo(paths.socketPath);
    const rotatedDaemonInfo = {
      ...initialDaemonInfo,
      wsPort: 4777,
      wsToken: ROTATED_DAEMON_WS_TOKEN,
      startedAt: "2026-04-06T12:05:00.000Z",
    } satisfies DesktopDaemonInfo;

    writeDaemonInfoFile(paths.daemonInfoPath, initialDaemonInfo);

    const resolver = createDesktopWsUrlResolver({ paths });

    expect(resolver.getWsUrl()).toBe(buildDaemonWsUrl(initialDaemonInfo));

    writeDaemonInfoFile(paths.daemonInfoPath, rotatedDaemonInfo);

    expect(resolver.getWsUrl()).toBe(buildDaemonWsUrl(rotatedDaemonInfo));
  });

  it("primes the websocket URL when daemon.json appears shortly after startup", async () => {
    const baseDir = makeTempDir("forge-desktop-daemon-prime-");
    const paths = resolveDesktopDaemonPaths(baseDir);
    const daemonInfo = makeDaemonInfo(paths.socketPath);
    const expectedWsUrl = buildDaemonWsUrl(daemonInfo);

    const resolver = createDesktopWsUrlResolver({
      paths,
      timeoutMs: 100,
      pollIntervalMs: 5,
    });

    expect(resolver.getWsUrl()).toBeNull();

    const writeTimer = setTimeout(() => {
      writeDaemonInfoFile(paths.daemonInfoPath, daemonInfo);
    }, 10);

    try {
      await expect(resolver.prime()).resolves.toBe(expectedWsUrl);
      expect(resolver.getWsUrl()).toBe(expectedWsUrl);
    } finally {
      clearTimeout(writeTimer);
    }
  });

  it("re-primes against the latest daemon.json after an earlier startup read", async () => {
    const baseDir = makeTempDir("forge-desktop-daemon-reprime-");
    const paths = resolveDesktopDaemonPaths(baseDir);
    const initialDaemonInfo = makeDaemonInfo(paths.socketPath);
    const rotatedDaemonInfo = {
      ...initialDaemonInfo,
      wsPort: 4888,
      wsToken: REPRIMED_DAEMON_WS_TOKEN,
      startedAt: "2026-04-06T12:10:00.000Z",
    } satisfies DesktopDaemonInfo;

    writeDaemonInfoFile(paths.daemonInfoPath, initialDaemonInfo);

    const resolver = createDesktopWsUrlResolver({
      paths,
      timeoutMs: 20,
      pollIntervalMs: 5,
    });

    await expect(resolver.prime()).resolves.toBe(buildDaemonWsUrl(initialDaemonInfo));

    writeDaemonInfoFile(paths.daemonInfoPath, rotatedDaemonInfo);

    await expect(resolver.prime()).resolves.toBe(buildDaemonWsUrl(rotatedDaemonInfo));
    expect(resolver.getWsUrl()).toBe(buildDaemonWsUrl(rotatedDaemonInfo));
  });

  it("ignores daemon.json files with mismatched socket paths when resolving the websocket URL", () => {
    const baseDir = makeTempDir("forge-desktop-daemon-resolver-mismatch-");
    const paths = resolveDesktopDaemonPaths(baseDir);
    const daemonInfo = makeDaemonInfo("/tmp/other-daemon.sock");

    writeDaemonInfoFile(paths.daemonInfoPath, daemonInfo);

    const resolver = createDesktopWsUrlResolver({ paths });

    expect(resolver.getWsUrl()).toBeNull();
  });
});
