import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS, ServerSettingsPatch } from "@forgetools/contracts";
import { assert, it } from "@effect/vitest";
import { Duration, Effect, FileSystem, Layer, Schema } from "effect";
import { test } from "vitest";
import { ServerConfig } from "./config";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings";

const makeServerSettingsLayer = () =>
  ServerSettingsLive.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-test-",
        }),
      ),
    ),
  );

const makeScopedServerSettingsRuntimeLayer = () =>
  Layer.merge(
    NodeServices.layer,
    makeServerSettingsLayer().pipe(Layer.provide(NodeServices.layer)),
  );

it.layer(NodeServices.layer)("server settings", (it) => {
  it.effect("decodes nested settings patches", () =>
    Effect.sync(() => {
      const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

      assert.deepEqual(decodePatch({ providers: { codex: { binaryPath: "/tmp/codex" } } }), {
        providers: { codex: { binaryPath: "/tmp/codex" } },
      });

      assert.deepEqual(
        decodePatch({
          textGenerationModelSelection: {
            options: {
              fastMode: false,
            },
          },
        }),
        {
          textGenerationModelSelection: {
            options: {
              fastMode: false,
            },
          },
        },
      );

      assert.deepEqual(
        decodePatch({
          notifications: {
            sessionCompleted: false,
          },
        }),
        {
          notifications: {
            sessionCompleted: false,
          },
        },
      );

      assert.deepEqual(
        decodePatch({
          appearance: {
            typography: {
              uiFontFamily: '"IBM Plex Sans", sans-serif',
            },
          },
        }),
        {
          appearance: {
            typography: {
              uiFontFamily: '"IBM Plex Sans", sans-serif',
            },
          },
        },
      );
    }),
  );

  it.effect("deep merges nested settings updates without dropping siblings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/usr/local/bin/codex",
            homePath: "/Users/julius/.codex",
          },
          claudeAgent: {
            binaryPath: "/usr/local/bin/claude",
            customModels: ["claude-custom"],
          },
        },
        textGenerationModelSelection: {
          provider: "codex",
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: {
            reasoningEffort: "high",
            fastMode: true,
          },
        },
      });

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
        },
        textGenerationModelSelection: {
          options: {
            fastMode: false,
          },
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "/Users/julius/.codex",
        customModels: [],
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/usr/local/bin/claude",
        customModels: ["claude-custom"],
      });
      assert.deepEqual(next.textGenerationModelSelection, {
        provider: "codex",
        model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
        options: {
          reasoningEffort: "high",
          fastMode: false,
        },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves model when switching providers via textGenerationModelSelection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      // Start with Claude text generation selection
      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "high",
          },
        },
      });

      // Switch to Codex — the stale Claude "effort" in options must not
      // cause the update to lose the selected model.
      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          provider: "codex",
          model: "gpt-5.4",
          options: {
            reasoningEffort: "high",
          },
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        provider: "codex",
        model: "gpt-5.4",
        options: {
          reasoningEffort: "high",
        },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("trims provider path settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "  /opt/homebrew/bin/codex  ",
            homePath: "   ",
          },
          claudeAgent: {
            binaryPath: "  /opt/homebrew/bin/claude  ",
          },
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "",
        customModels: [],
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/claude",
        customModels: [],
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("trims observability settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        observability: {
          otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
          otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
        },
      });

      assert.deepEqual(next.observability, {
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("deep merges notification settings updates without dropping siblings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      yield* serverSettings.updateSettings({
        notifications: {
          sessionNeedsAttention: false,
          sessionCompleted: false,
        },
      });

      const next = yield* serverSettings.updateSettings({
        notifications: {
          deliberationConcluded: false,
        },
      });

      assert.deepEqual(next.notifications, {
        sessionNeedsAttention: false,
        sessionCompleted: false,
        deliberationConcluded: false,
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("defaults blank binary paths to provider executables", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "   ",
          },
          claudeAgent: {
            binaryPath: "",
          },
        },
      });

      assert.equal(next.providers.codex.binaryPath, "codex");
      assert.equal(next.providers.claudeAgent.binaryPath, "claude");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("writes only non-default server settings to disk", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const next = yield* serverSettings.updateSettings({
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
        },
      });

      assert.equal(next.providers.codex.binaryPath, "/opt/homebrew/bin/codex");

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.deepEqual(JSON.parse(raw), {
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
        },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists sparse appearance overrides and reloads them from disk", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;

      yield* serverSettings.updateSettings({
        appearance: {
          typography: {
            uiFontFamily: '"IBM Plex Sans", sans-serif',
          },
          dark: {
            ui: {
              background: "#101418",
            },
          },
        },
      });

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.deepEqual(JSON.parse(raw), {
        appearance: {
          typography: {
            uiFontFamily: '"IBM Plex Sans", sans-serif',
          },
          dark: {
            ui: {
              background: "#101418",
            },
          },
        },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
});

test("reloads appearance settings and surfaces appearance issues from external edits", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;

      yield* serverSettings.start;
      yield* serverSettings.ready;

      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        `${JSON.stringify(
          {
            appearance: {
              typography: {
                uiFontFamily: '"IBM Plex Sans", sans-serif',
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      yield* Effect.sleep(Duration.millis(250));

      const reloaded = yield* serverSettings.getSettingsState;
      assert.equal(
        reloaded.settings.appearance.typography.uiFontFamily,
        '"IBM Plex Sans", sans-serif',
      );
      assert.deepEqual(reloaded.issues, []);

      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        `${JSON.stringify(
          {
            appearance: {
              typography: {
                terminalFontSize: "big",
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      yield* Effect.sleep(Duration.millis(250));

      const invalidState = yield* serverSettings.getSettingsState;
      assert.equal(
        invalidState.settings.appearance.typography.terminalFontSize,
        DEFAULT_SERVER_SETTINGS.appearance.typography.terminalFontSize,
      );
      assert.equal(invalidState.issues[0]?.kind, "appearance.malformed-config");
    }).pipe(Effect.provide(makeScopedServerSettingsRuntimeLayer()), Effect.scoped),
  );
});
