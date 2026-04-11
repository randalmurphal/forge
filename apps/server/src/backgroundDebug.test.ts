import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendBackgroundDebugRecord,
  isBackgroundDebugEnabled,
  resolveBackgroundDebugLogPath,
} from "./backgroundDebug";

describe("backgroundDebug", () => {
  it("detects enabled debug flags from the environment", () => {
    expect(isBackgroundDebugEnabled({ FORGE_DEBUG_BACKGROUND_TASKS: "1" })).toBe(true);
    expect(isBackgroundDebugEnabled({ FORGE_DEBUG_BACKGROUND_TASKS: "true" })).toBe(true);
    expect(isBackgroundDebugEnabled({ FORGE_DEBUG_BACKGROUND_TASKS: "0" })).toBe(false);
  });

  it("writes under the dev state directory when the Vite dev server env is present", () => {
    const homeDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-bg-debug-home-"));
    const logPath = resolveBackgroundDebugLogPath(
      {
        FORGE_HOME: homeDir,
        VITE_DEV_SERVER_URL: "http://localhost:5734",
      },
      homeDir,
    );

    expect(logPath).toBe(Path.join(homeDir, "dev", "logs", "background-debug.ndjson"));
  });

  it("appends newline-delimited records when debug is enabled", () => {
    const homeDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-bg-debug-write-"));
    const env = {
      FORGE_HOME: homeDir,
      FORGE_DEBUG_BACKGROUND_TASKS: "1",
      VITE_DEV_SERVER_URL: "http://localhost:5734",
    };

    appendBackgroundDebugRecord("adapter", "item.completed", { itemId: "cmd-1" }, env);

    const logPath = Path.join(homeDir, "dev", "logs", "background-debug.ndjson");
    const content = FS.readFileSync(logPath, "utf8").trim();
    expect(content.length).toBeGreaterThan(0);

    const parsed = JSON.parse(content) as {
      source: string;
      label: string;
      details: { itemId: string };
    };
    expect(parsed.source).toBe("adapter");
    expect(parsed.label).toBe("item.completed");
    expect(parsed.details.itemId).toBe("cmd-1");
  });
});
