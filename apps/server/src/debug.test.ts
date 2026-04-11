import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  appendServerDebugRecord,
  resolveServerDebugConfig,
  resolveServerDebugLogPath,
} from "./debug";

describe("debug", () => {
  it("detects enabled topics from the main debug env var", () => {
    const config = resolveServerDebugConfig({ FORGE_DEBUG: "background,rpc" });

    expect(config.enabled).toBe(true);
    expect(config.all).toBe(false);
    expect(config.topics.has("background")).toBe(true);
    expect(config.topics.has("rpc")).toBe(true);
  });

  it("supports all-topics debug values", () => {
    const config = resolveServerDebugConfig({ FORGE_DEBUG: "all" });

    expect(config.enabled).toBe(true);
    expect(config.all).toBe(true);
  });

  it("writes under the dev state directory when the Vite dev server env is present", () => {
    const homeDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-debug-home-"));
    const logPath = resolveServerDebugLogPath(
      {
        FORGE_HOME: homeDir,
        VITE_DEV_SERVER_URL: "http://localhost:5734",
      },
      homeDir,
    );

    expect(logPath).toBe(Path.join(homeDir, "dev", "logs", "debug.ndjson"));
  });

  it("appends newline-delimited records and mirrors them to the console when enabled", () => {
    const homeDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-debug-write-"));
    const env = {
      FORGE_HOME: homeDir,
      FORGE_DEBUG: "background",
      VITE_DEV_SERVER_URL: "http://localhost:5734",
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      appendServerDebugRecord({
        topic: "background",
        source: "adapter",
        label: "item.completed",
        details: { itemId: "cmd-1" },
        env,
      });
      const logPath = Path.join(homeDir, "dev", "logs", "debug.ndjson");
      const content = FS.readFileSync(logPath, "utf8").trim();
      expect(content.length).toBeGreaterThan(0);

      const parsed = JSON.parse(content) as {
        topic: string;
        source: string;
        label: string;
        details: { itemId: string };
      };
      expect(parsed.topic).toBe("background");
      expect(parsed.source).toBe("adapter");
      expect(parsed.label).toBe("item.completed");
      expect(parsed.details.itemId).toBe("cmd-1");
      expect(warnSpy).toHaveBeenCalledWith("[forge:background:adapter] item.completed", {
        itemId: "cmd-1",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});
