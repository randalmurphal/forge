import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Path } from "effect";

import { deriveServerPaths } from "./config.ts";

it.layer(NodeServices.layer)("deriveServerPaths", (it) => {
  it.effect("uses the documented Forge root layout outside dev mode", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = "/tmp/forge-config-root";

      const paths = yield* deriveServerPaths(baseDir, undefined);

      assert.deepStrictEqual(paths, {
        stateDir: baseDir,
        dbPath: join(baseDir, "forge.db"),
        keybindingsConfigPath: join(baseDir, "keybindings.json"),
        settingsPath: join(baseDir, "settings.json"),
        worktreesDir: join(baseDir, "worktrees"),
        attachmentsDir: join(baseDir, "attachments"),
        artifactsDir: join(baseDir, "artifacts"),
        logsDir: join(baseDir, "logs"),
        serverLogPath: join(baseDir, "logs", "server.log"),
        serverTracePath: join(baseDir, "logs", "server.trace.ndjson"),
        providerLogsDir: join(baseDir, "logs", "sessions"),
        providerEventLogPath: join(baseDir, "logs", "provider-events.log"),
        terminalLogsDir: join(baseDir, "logs", "terminals"),
        anonymousIdPath: join(baseDir, "telemetry", "anonymous-id"),
      });
    }),
  );

  it.effect("keeps dev runtime data isolated under the dev directory", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = "/tmp/forge-config-dev";
      const stateDir = join(baseDir, "dev");

      const paths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:5173"));

      assert.deepStrictEqual(paths, {
        stateDir,
        dbPath: join(stateDir, "forge.db"),
        keybindingsConfigPath: join(stateDir, "keybindings.json"),
        settingsPath: join(stateDir, "settings.json"),
        worktreesDir: join(baseDir, "worktrees"),
        attachmentsDir: join(stateDir, "attachments"),
        artifactsDir: join(stateDir, "artifacts"),
        logsDir: join(stateDir, "logs"),
        serverLogPath: join(stateDir, "logs", "server.log"),
        serverTracePath: join(stateDir, "logs", "server.trace.ndjson"),
        providerLogsDir: join(stateDir, "logs", "sessions"),
        providerEventLogPath: join(stateDir, "logs", "provider-events.log"),
        terminalLogsDir: join(stateDir, "logs", "terminals"),
        anonymousIdPath: join(stateDir, "telemetry", "anonymous-id"),
      });
    }),
  );
});
