import { describe, expect, it, vi } from "vitest";

import type { DesktopDaemonInfo } from "./daemonLifecycle";
import {
  buildDaemonWsUrl,
  buildDesktopWindowUrl,
  buildDetachedDaemonLaunchPlan,
  ensureDaemonConnection,
  extractProtocolUrlFromArgv,
  handleDesktopBeforeQuit,
  isDesktopUiReady,
  launchDetachedDaemon,
  parseSessionProtocolUrl,
  registerProtocolClient,
  requestSingleInstanceOrQuit,
} from "./daemonLifecycle";

const daemonInfo: DesktopDaemonInfo = {
  pid: 42,
  wsPort: 3773,
  wsToken: "secret-token",
  socketPath: "/tmp/forge.sock",
  startedAt: "2026-04-06T12:00:00.000Z",
};

describe("ensureDaemonConnection", () => {
  it("discovers an existing daemon without spawning a new process", async () => {
    const spawnDetachedDaemon = vi.fn(async () => undefined);
    const readDaemonInfo = vi.fn(async () => daemonInfo);
    const pingDaemon = vi.fn(async () => true);

    const result = await ensureDaemonConnection({
      paths: {
        baseDir: "/tmp/forge",
        socketPath: daemonInfo.socketPath,
        daemonInfoPath: "/tmp/forge/daemon.json",
      },
      spawnDetachedDaemon,
      readDaemonInfo,
      pingDaemon,
    });

    expect(result).toEqual({
      info: daemonInfo,
      source: "existing",
      wsUrl: "ws://127.0.0.1:3773/?token=secret-token",
    });
    expect(spawnDetachedDaemon).not.toHaveBeenCalled();
  });

  it("spawns and waits for the daemon when none is running", async () => {
    const spawnDetachedDaemon = vi.fn(async () => undefined);
    const readDaemonInfo = vi
      .fn<(_: string) => Promise<DesktopDaemonInfo | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(daemonInfo);
    const pingDaemon = vi.fn<(_: string) => Promise<boolean>>().mockResolvedValueOnce(true);

    const result = await ensureDaemonConnection({
      paths: {
        baseDir: "/tmp/forge",
        socketPath: daemonInfo.socketPath,
        daemonInfoPath: "/tmp/forge/daemon.json",
      },
      spawnDetachedDaemon,
      readDaemonInfo,
      pingDaemon,
      timeoutMs: 100,
      pollIntervalMs: 0,
    });

    expect(result.source).toBe("spawned");
    expect(result.wsUrl).toBe("ws://127.0.0.1:3773/?token=secret-token");
    expect(spawnDetachedDaemon).toHaveBeenCalledTimes(1);
  });
});

describe("daemon process launch", () => {
  it("builds a detached daemon launch plan for Electron-hosted startup", () => {
    const plan = buildDetachedDaemonLaunchPlan({
      baseDir: "/Users/randy/.forge",
      entryScriptPath: "/app/apps/server/dist/bin.mjs",
      cwd: "/Users/randy",
      execPath: "/Applications/Forge.app/Contents/MacOS/Forge",
      env: {
        PATH: "/usr/bin",
      },
    });

    expect(plan).toEqual({
      command: "/Applications/Forge.app/Contents/MacOS/Forge",
      args: [
        "/app/apps/server/dist/bin.mjs",
        "--mode",
        "daemon",
        "--no-browser",
        "--base-dir",
        "/Users/randy/.forge",
      ],
      cwd: "/Users/randy",
      env: {
        PATH: "/usr/bin",
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
  });

  it("launches the daemon as a detached ignored-stdio process and unreferences it", async () => {
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref }) as never);

    await launchDetachedDaemon(
      {
        command: "node",
        args: ["server.mjs"],
        cwd: "/tmp",
        env: { PATH: "/usr/bin" },
      },
      spawn,
    );

    expect(spawn).toHaveBeenCalledWith("node", ["server.mjs"], {
      cwd: "/tmp",
      env: { PATH: "/usr/bin" },
      detached: true,
      stdio: "ignore",
    });
    expect(unref).toHaveBeenCalledTimes(1);
  });
});

describe("single-instance and protocol helpers", () => {
  it("quits when the single-instance lock cannot be acquired", () => {
    const quit = vi.fn();
    const acquired = requestSingleInstanceOrQuit({
      requestSingleInstanceLock: () => false,
      quit,
    });

    expect(acquired).toBe(false);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("registers Forge as the default protocol client", () => {
    const setAsDefaultProtocolClient = vi.fn(() => true);

    const registered = registerProtocolClient(
      {
        setAsDefaultProtocolClient,
      },
      "forge",
    );

    expect(registered).toBe(true);
    expect(setAsDefaultProtocolClient).toHaveBeenCalledWith("forge");
  });

  it("extracts and parses forge session deep links", () => {
    const protocolUrl = extractProtocolUrlFromArgv(
      ["Forge", "--flag", "forge://session/thread-123"],
      "forge",
    );

    expect(protocolUrl).toBe("forge://session/thread-123");
    expect(parseSessionProtocolUrl(protocolUrl!, "forge")).toEqual({
      threadId: "thread-123",
    });
  });
});

describe("desktop UI readiness", () => {
  it("requires the app to be ready and the daemon websocket URL to exist", () => {
    expect(
      isDesktopUiReady({
        appReady: true,
        backendWsUrl: "ws://127.0.0.1:3773/?token=secret-token",
      }),
    ).toBe(true);
    expect(
      isDesktopUiReady({
        appReady: false,
        backendWsUrl: "ws://127.0.0.1:3773/?token=secret-token",
      }),
    ).toBe(false);
    expect(
      isDesktopUiReady({
        appReady: true,
        backendWsUrl: "   ",
      }),
    ).toBe(false);
  });
});

describe("desktop URL helpers", () => {
  it("builds the daemon websocket URL from daemon.json data", () => {
    expect(buildDaemonWsUrl(daemonInfo)).toBe("ws://127.0.0.1:3773/?token=secret-token");
  });

  it("routes window navigation through the desktop scheme or dev server hash", () => {
    expect(buildDesktopWindowUrl({ scheme: "forge", threadId: "thread-123" })).toBe(
      "forge://app/index.html#/thread-123",
    );
    expect(
      buildDesktopWindowUrl({
        scheme: "forge",
        threadId: "thread-123",
        devServerUrl: "http://127.0.0.1:5173/",
      }),
    ).toBe("http://127.0.0.1:5173/#/thread-123");
  });
});

describe("handleDesktopBeforeQuit", () => {
  it("marks the app as quitting without attempting to stop the daemon", () => {
    const markQuitting = vi.fn();
    const clearUpdatePollTimer = vi.fn();
    const restoreStdIoCapture = vi.fn();
    const stopDaemon = vi.fn();

    handleDesktopBeforeQuit({
      markQuitting,
      clearUpdatePollTimer,
      restoreStdIoCapture,
      stopDaemon,
    });

    expect(markQuitting).toHaveBeenCalledTimes(1);
    expect(clearUpdatePollTimer).toHaveBeenCalledTimes(1);
    expect(restoreStdIoCapture).toHaveBeenCalledTimes(1);
    expect(stopDaemon).not.toHaveBeenCalled();
  });
});
