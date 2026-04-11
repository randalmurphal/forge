import { describe, expect, it } from "vitest";

import { resolveDaemonProcessEnv } from "./daemonEnv";

describe("resolveDaemonProcessEnv", () => {
  it("strips daemon runtime overrides while preserving unrelated environment values", () => {
    expect(
      resolveDaemonProcessEnv({
        FORGE_PORT: "3773",
        FORGE_AUTH_TOKEN: "secret",
        FORGE_MODE: "desktop",
        FORGE_NO_BROWSER: "1",
        FORGE_HOST: "127.0.0.1",
        PATH: "/usr/bin",
      }),
    ).toEqual({
      PATH: "/usr/bin",
    });
  });

  it("preserves the initial debug flag when the current Electron env no longer has it", () => {
    expect(
      resolveDaemonProcessEnv(
        {
          PATH: "/usr/bin",
        },
        {
          PATH: "/usr/bin",
          FORGE_DEBUG: "all",
        },
      ),
    ).toEqual({
      PATH: "/usr/bin",
      FORGE_DEBUG: "all",
    });
  });
});
