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

const tempDirs: string[] = [];

const makeTempDir = (prefix: string): string => {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const makeDaemonInfo = (socketPath: string): DesktopDaemonInfo => ({
  pid: 42,
  wsPort: 3773,
  wsToken: "secret-token",
  socketPath,
  startedAt: "2026-04-06T12:00:00.000Z",
});

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

    FS.writeFileSync(paths.daemonInfoPath, JSON.stringify(daemonInfo), "utf8");

    expect(readDaemonInfoSync(paths.daemonInfoPath)).toEqual(daemonInfo);
  });

  it("returns undefined for malformed daemon.json data", () => {
    const baseDir = makeTempDir("forge-desktop-daemon-invalid-");
    const paths = resolveDesktopDaemonPaths(baseDir);

    FS.writeFileSync(paths.daemonInfoPath, '{"pid":"oops"}', "utf8");

    expect(readDaemonInfoSync(paths.daemonInfoPath)).toBeUndefined();
  });
});

describe("createDesktopWsUrlResolver", () => {
  it("resolves the websocket URL from an existing daemon.json file", () => {
    const baseDir = makeTempDir("forge-desktop-daemon-url-");
    const paths = resolveDesktopDaemonPaths(baseDir);
    const daemonInfo = makeDaemonInfo(paths.socketPath);

    FS.writeFileSync(paths.daemonInfoPath, JSON.stringify(daemonInfo), "utf8");

    const resolver = createDesktopWsUrlResolver({ paths });

    expect(resolver.getWsUrl()).toBe(buildDaemonWsUrl(daemonInfo));
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
      FS.writeFileSync(paths.daemonInfoPath, JSON.stringify(daemonInfo), "utf8");
    }, 10);

    try {
      await expect(resolver.prime()).resolves.toBe(expectedWsUrl);
      expect(resolver.getWsUrl()).toBe(expectedWsUrl);
    } finally {
      clearTimeout(writeTimer);
    }
  });
});
