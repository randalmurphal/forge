import { describe, expect, it } from "vitest";

import { resolveDesktopBackendLaunchSpec } from "./daemonLaunch";

describe("resolveDesktopBackendLaunchSpec", () => {
  it("uses the live server source entry in development", () => {
    expect(
      resolveDesktopBackendLaunchSpec({
        appRoot: "/workspace/forge",
        isDevelopment: true,
      }),
    ).toEqual({
      entryScriptPath: "/workspace/forge/apps/server/src/bin.ts",
      execPath: "bun",
    });
  });

  it("uses the built server bundle outside development", () => {
    expect(
      resolveDesktopBackendLaunchSpec({
        appRoot: "/workspace/forge",
        isDevelopment: false,
      }),
    ).toEqual({
      entryScriptPath: "/workspace/forge/apps/server/dist/bin.mjs",
      execPath: "node",
    });
  });
});
