/**
 * ServerSettings - Server-authoritative settings service.
 *
 * Owns persistence, validation, and change notification of settings that affect
 * server-side behavior (binary paths, streaming mode, env mode, custom models,
 * text generation model selection).
 *
 * Follows the same pattern as `keybindings.ts`: JSON file + Cache + PubSub +
 * Semaphore + FileSystem.watch for concurrency and external edit detection.
 *
 * @module ServerSettings
 */
import {
  AppearanceSettings,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type ProviderKind,
  type ServerConfigIssue,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
} from "@forgetools/contracts";
import {
  Cache,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Equal,
  Option,
  PubSub,
  Ref,
  Schema,
  SchemaIssue,
  Scope,
  ServiceMap,
  Stream,
  Cause,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { ServerConfig } from "./config";
import { type DeepPartial, deepMerge } from "@forgetools/shared/Struct";
import { fromLenientJson } from "@forgetools/shared/schemaJson";

export interface ServerSettingsShape {
  /** Start the settings runtime and attach file watching. */
  readonly start: Effect.Effect<void, ServerSettingsError>;

  /** Await settings runtime readiness. */
  readonly ready: Effect.Effect<void, ServerSettingsError>;

  /** Read the current settings. */
  readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

  /** Read the current settings plus any config issues surfaced during load. */
  readonly getSettingsState: Effect.Effect<
    { settings: ServerSettings; issues: readonly ServerConfigIssue[] },
    ServerSettingsError
  >;

  /** Patch settings and persist. Returns the new full settings object. */
  readonly updateSettings: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;

  /** Stream of settings change events. */
  readonly streamChanges: Stream.Stream<ServerSettings>;

  /** Stream of settings state change events. */
  readonly streamStateChanges: Stream.Stream<{
    settings: ServerSettings;
    issues: readonly ServerConfigIssue[];
  }>;
}

export class ServerSettingsService extends ServiceMap.Service<
  ServerSettingsService,
  ServerSettingsShape
>()("forge/serverSettings/ServerSettingsService") {
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> = {}) =>
    Layer.effect(
      ServerSettingsService,
      Effect.gen(function* () {
        const currentSettingsRef = yield* Ref.make<ServerSettings>(
          deepMerge(DEFAULT_SERVER_SETTINGS, overrides),
        );

        return {
          start: Effect.void,
          ready: Effect.void,
          getSettings: Ref.get(currentSettingsRef),
          getSettingsState: Ref.get(currentSettingsRef).pipe(
            Effect.map((settings) => ({ settings, issues: [] as const })),
          ),
          updateSettings: (patch) =>
            Ref.get(currentSettingsRef).pipe(
              Effect.map((currentSettings) => deepMerge(currentSettings, patch)),
              Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
            ),
          streamChanges: Stream.empty,
          streamStateChanges: Stream.empty,
        } satisfies ServerSettingsShape;
      }),
    );
}

const ServerSettingsJson = fromLenientJson(ServerSettings);

const PROVIDER_ORDER: readonly ProviderKind[] = ["codex", "claudeAgent"];

/**
 * Ensure the `textGenerationModelSelection` points to an enabled provider.
 * If the selected provider is disabled, fall back to the first enabled
 * provider with its default model.  This is applied at read-time so the
 * persisted preference is preserved for when a provider is re-enabled.
 */
function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const selection = settings.textGenerationModelSelection;
  if (settings.providers[selection.provider].enabled) {
    return settings;
  }

  const fallback = PROVIDER_ORDER.find((p) => settings.providers[p].enabled);
  if (!fallback) {
    // No providers enabled — return as-is; callers will report the error.
    return settings;
  }

  return {
    ...settings,
    textGenerationModelSelection: {
      provider: fallback,
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[fallback],
    } as ModelSelection,
  };
}

function resolveSettingsState(state: {
  settings: ServerSettings;
  issues: readonly ServerConfigIssue[];
}): { settings: ServerSettings; issues: readonly ServerConfigIssue[] } {
  const mergedSettings = deepMerge(DEFAULT_SERVER_SETTINGS, state.settings);
  return {
    settings: resolveTextGenerationProvider(mergedSettings),
    issues: state.issues,
  };
}

function appearanceMalformedConfigIssue(detail: string): ServerConfigIssue {
  return {
    kind: "appearance.malformed-config",
    message: detail,
  };
}

// Values under these keys are compared as a whole — never stripped field-by-field.
const ATOMIC_SETTINGS_KEYS: ReadonlySet<string> = new Set(["textGenerationModelSelection"]);

function stripDefaultServerSettings(current: unknown, defaults: unknown): unknown | undefined {
  if (Array.isArray(current) || Array.isArray(defaults)) {
    return Equal.equals(current, defaults) ? undefined : current;
  }

  if (
    current !== null &&
    defaults !== null &&
    typeof current === "object" &&
    typeof defaults === "object"
  ) {
    const currentRecord = current as Record<string, unknown>;
    const defaultsRecord = defaults as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const key of Object.keys(currentRecord)) {
      if (ATOMIC_SETTINGS_KEYS.has(key)) {
        if (!Equal.equals(currentRecord[key], defaultsRecord[key])) {
          next[key] = currentRecord[key];
        }
      } else {
        const stripped = stripDefaultServerSettings(currentRecord[key], defaultsRecord[key]);
        if (stripped !== undefined) {
          next[key] = stripped;
        }
      }
    }

    return Object.keys(next).length > 0 ? next : undefined;
  }

  return Object.is(current, defaults) ? undefined : current;
}

const makeServerSettings = Effect.gen(function* () {
  const { settingsPath } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const writeSemaphore = yield* Semaphore.make(1);
  const cacheKey = "settings" as const;
  const changesPubSub = yield* PubSub.unbounded<{
    settings: ServerSettings;
    issues: readonly ServerConfigIssue[];
  }>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();
  const watcherScope = yield* Scope.make("sequential");
  const watcherFiberRef = yield* Ref.make<Option.Option<Fiber.Fiber<void, never>>>(Option.none());
  yield* Effect.addFinalizer((_exit) =>
    Effect.gen(function* () {
      const watcherFiber = yield* Ref.get(watcherFiberRef);
      if (Option.isSome(watcherFiber)) {
        yield* Fiber.interrupt(watcherFiber.value).pipe(Effect.ignore);
      }
      yield* Scope.close(watcherScope, Exit.void);
    }),
  );

  const emitChange = (state: { settings: ServerSettings; issues: readonly ServerConfigIssue[] }) =>
    PubSub.publish(changesPubSub, resolveSettingsState(state)).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          detail: "failed to check settings file existence",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          detail: "failed to read settings file",
          cause,
        }),
    ),
  );

  const loadSettingsFromDisk = Effect.gen(function* () {
    if (!(yield* readConfigExists)) {
      return { settings: DEFAULT_SERVER_SETTINGS, issues: [] as readonly ServerConfigIssue[] };
    }

    const raw = yield* readRawConfig;
    const decoded = Schema.decodeUnknownExit(ServerSettingsJson)(raw);
    if (decoded._tag === "Failure") {
      yield* Effect.logWarning("failed to parse settings.json, using defaults", {
        path: settingsPath,
        issues: Cause.pretty(decoded.cause),
      });
      const parsedJsonExit = yield* Effect.exit(
        Effect.try({
          try: () => JSON.parse(raw) as unknown,
          catch: (cause) =>
            new ServerSettingsError({
              settingsPath,
              detail: "failed to parse settings file JSON",
              cause,
            }),
        }),
      );
      if (parsedJsonExit._tag === "Failure") {
        return { settings: DEFAULT_SERVER_SETTINGS, issues: [] as readonly ServerConfigIssue[] };
      }
      const parsed = parsedJsonExit.value;
      if (parsed === null || typeof parsed !== "object" || !("appearance" in parsed)) {
        return { settings: DEFAULT_SERVER_SETTINGS, issues: [] as readonly ServerConfigIssue[] };
      }

      const appearanceDecoded = Schema.decodeUnknownExit(AppearanceSettings)(parsed.appearance);
      const appearanceIssue =
        appearanceDecoded._tag === "Failure"
          ? appearanceMalformedConfigIssue(Cause.pretty(appearanceDecoded.cause))
          : null;
      const recoveredInput = { ...(parsed as Record<string, unknown>) };
      delete recoveredInput.appearance;
      const recovered = Schema.decodeUnknownExit(ServerSettings)(recoveredInput);
      if (recovered._tag === "Success" && appearanceIssue) {
        return {
          settings: {
            ...recovered.value,
            appearance: DEFAULT_SERVER_SETTINGS.appearance,
          },
          issues: [appearanceIssue] as const,
        };
      }

      return {
        settings: DEFAULT_SERVER_SETTINGS,
        issues: appearanceIssue ? ([appearanceIssue] as const) : [],
      };
    }

    return { settings: decoded.value, issues: [] as readonly ServerConfigIssue[] };
  });

  const settingsCache = yield* Cache.make<
    typeof cacheKey,
    { settings: ServerSettings; issues: readonly ServerConfigIssue[] },
    ServerSettingsError
  >({
    capacity: 1,
    lookup: () => loadSettingsFromDisk,
  });

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey);

  const writeSettingsAtomically = (settings: ServerSettings) => {
    const tempPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
    const sparseSettings = stripDefaultServerSettings(settings, DEFAULT_SERVER_SETTINGS) ?? {};

    return Effect.succeed(`${JSON.stringify(sparseSettings, null, 2)}\n`).pipe(
      Effect.tap(() => fs.makeDirectory(pathService.dirname(settingsPath), { recursive: true })),
      Effect.tap((encoded) => fs.writeFileString(tempPath, encoded)),
      Effect.flatMap(() => fs.rename(tempPath, settingsPath)),
      Effect.ensuring(fs.remove(tempPath, { force: true }).pipe(Effect.ignore({ log: true }))),
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to write settings file",
            cause,
          }),
      ),
    );
  };

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(settingsCache, cacheKey);
      const settingsState = yield* getSettingsFromCache;
      yield* emitChange(settingsState);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const settingsDir = pathService.dirname(settingsPath);
    const settingsFile = pathService.basename(settingsPath);
    const settingsPathResolved = pathService.resolve(settingsPath);

    yield* fs.makeDirectory(settingsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to prepare settings directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));
    const revalidateAfterWatchEvent = Effect.gen(function* () {
      yield* revalidateAndEmitSafely;
      yield* Effect.sleep(Duration.millis(150));
      yield* revalidateAndEmitSafely;
    });

    // Debounce watch events so the file is fully written before we read it.
    // Editors emit multiple events per save (truncate, write, rename) and
    // `fs.watch` can fire before the content has been flushed to disk.
    const debouncedSettingsEvents = fs.watch(settingsDir).pipe(
      Stream.filter((event) => {
        if (!event.path) {
          return true;
        }
        return (
          event.path === settingsFile ||
          event.path === settingsPath ||
          pathService.resolve(settingsDir, event.path) === settingsPathResolved
        );
      }),
      Stream.debounce(Duration.millis(100)),
    );

    const watcherFiber = yield* Stream.runForEach(
      debouncedSettingsEvents,
      () => revalidateAfterWatchEvent,
    ).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(watcherScope));
    yield* Ref.set(watcherFiberRef, Option.some(watcherFiber));
  });

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      if (!(yield* readConfigExists)) {
        yield* writeSettingsAtomically(DEFAULT_SERVER_SETTINGS);
      }
      yield* startWatcher;
      yield* Effect.sleep(Duration.millis(50));
      yield* Cache.invalidate(settingsCache, cacheKey);
      yield* getSettingsFromCache;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    getSettings: getSettingsFromCache.pipe(
      Effect.map((state) => resolveSettingsState(state).settings),
    ),
    getSettingsState: getSettingsFromCache.pipe(Effect.map(resolveSettingsState)),
    updateSettings: (patch) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* getSettingsFromCache;
          const next = yield* Schema.decodeEffect(ServerSettings)(
            deepMerge(current.settings, patch),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath: "<memory>",
                  detail: `failed to normalize server settings: ${SchemaIssue.makeFormatterDefault()(cause.issue)}`,
                  cause,
                }),
            ),
          );
          yield* writeSettingsAtomically(next);
          yield* Cache.set(settingsCache, cacheKey, { settings: next, issues: [] });
          yield* emitChange({ settings: next, issues: [] });
          return resolveTextGenerationProvider(next);
        }),
      ),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub).pipe(Stream.map((state) => state.settings));
    },
    get streamStateChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerSettingsShape;
});

export const ServerSettingsLive = Layer.effect(ServerSettingsService, makeServerSettings);
