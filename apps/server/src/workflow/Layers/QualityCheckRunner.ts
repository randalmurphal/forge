import * as OS from "node:os";
import { exec, type ExecException } from "node:child_process";
import {
  ForgeProjectConfig,
  type ForgeProjectConfig as ForgeProjectConfigData,
  type QualityCheckResult,
} from "@forgetools/contracts";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import {
  QualityCheckRunner,
  type QualityCheckRunnerShape,
} from "../Services/QualityCheckRunner.ts";
import {
  QualityCheckRunnerFileError,
  QualityCheckRunnerParseError,
  toQualityCheckRunnerDecodeError,
} from "../Errors.ts";

export interface QualityCheckRunnerLiveOptions {
  readonly globalConfigPath?: string;
}

interface ResolvedQualityCheckConfig {
  readonly command: string;
  readonly timeout: number;
  readonly sourcePath: string;
}

interface ShellExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}

const decodeForgeProjectConfig = Schema.decodeUnknownEffect(ForgeProjectConfig);
const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function formatExecutionOutput(input: {
  readonly command: string;
  readonly timeoutMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly sourcePath: string;
}): string {
  const sections = [
    `Source: ${input.sourcePath}`,
    `Command: ${input.command}`,
    input.timedOut
      ? `Result: timed out after ${input.timeoutMs}ms.`
      : input.code === 0
        ? "Result: passed."
        : input.code !== null
          ? `Result: failed with exit code ${input.code}.`
          : input.signal
            ? `Result: terminated by signal ${input.signal}.`
            : "Result: failed.",
  ];

  const trimmedStdout = input.stdout.trimEnd();
  if (trimmedStdout.length > 0) {
    sections.push(`stdout:\n${trimmedStdout}`);
  }

  const trimmedStderr = input.stderr.trimEnd();
  if (trimmedStderr.length > 0) {
    sections.push(`stderr:\n${trimmedStderr}`);
  }

  return sections.join("\n\n");
}

function formatMissingConfigOutput(check: string, searchedPaths: ReadonlyArray<string>): string {
  return [
    `Quality check '${check}' was not executed because no Forge config file was found.`,
    `Searched: ${searchedPaths.join(", ")}`,
  ].join("\n");
}

function formatMissingCheckOutput(check: string, searchedPaths: ReadonlyArray<string>): string {
  return [
    `Quality check '${check}' is not configured in Forge project config.`,
    `Searched: ${searchedPaths.join(", ")}`,
  ].join("\n");
}

function runShellCommand(
  command: string,
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
  },
): Promise<ShellExecutionResult> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({
            stdout,
            stderr,
            code: 0,
            signal: null,
            timedOut: false,
          });
          return;
        }

        const execError = error as ExecException;
        resolve({
          stdout,
          stderr,
          code: typeof execError.code === "number" ? execError.code : null,
          signal: execError.signal ?? null,
          timedOut: execError.killed === true,
        });
      },
    );
  });
}

export const makeQualityCheckRunner = Effect.fn("makeQualityCheckRunner")(function* (
  options?: QualityCheckRunnerLiveOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const globalConfigPath =
    options?.globalConfigPath ?? path.join(OS.homedir(), ".forge", "config.json");

  const loadConfigFile = Effect.fn("QualityCheckRunner.loadConfigFile")(function* (
    filePath: string,
  ) {
    const exists = yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return Option.none<ForgeProjectConfigData>();
    }

    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.mapError(
        (cause) =>
          new QualityCheckRunnerFileError({
            path: filePath,
            operation: "qualityCheckRunner.readConfig",
            detail: cause.message,
            cause,
          }),
      ),
    );

    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new QualityCheckRunnerParseError({
          path: filePath,
          detail: cause instanceof Error ? cause.message : "Failed to parse Forge config JSON.",
          cause,
        }),
    });

    const config = yield* decodeForgeProjectConfig(parsed).pipe(
      Effect.mapError(toQualityCheckRunnerDecodeError(filePath)),
    );

    return Option.some(config);
  });

  const resolveQualityChecks = Effect.fn("QualityCheckRunner.resolveQualityChecks")(function* (
    projectRoot: string,
  ) {
    const projectConfigPath = path.join(projectRoot, ".forge", "config.json");
    const searchedPaths = [projectConfigPath, globalConfigPath] as const;
    const [globalConfig, projectConfig] = yield* Effect.all([
      loadConfigFile(globalConfigPath),
      loadConfigFile(projectConfigPath),
    ]);

    const merged = new Map<string, ResolvedQualityCheckConfig>();
    const addEntries = (
      configOption: Option.Option<ForgeProjectConfigData>,
      sourcePath: string,
    ): void => {
      if (Option.isNone(configOption) || !configOption.value.qualityChecks) {
        return;
      }

      for (const [name, config] of Object.entries(configOption.value.qualityChecks)) {
        merged.set(name, {
          command: config.command,
          timeout: config.timeout,
          sourcePath,
        });
      }
    };

    addEntries(globalConfig, globalConfigPath);
    addEntries(projectConfig, projectConfigPath);

    return {
      qualityChecks: merged,
      searchedPaths,
    };
  });

  const executeQualityCheck = Effect.fn("QualityCheckRunner.executeQualityCheck")(
    function* (input: {
      readonly check: string;
      readonly config: ResolvedQualityCheckConfig;
      readonly sourcePath: string;
      readonly worktreeDir: string;
    }) {
      const execution = yield* Effect.tryPromise({
        try: () =>
          runShellCommand(input.config.command, {
            cwd: input.worktreeDir,
            timeoutMs: input.config.timeout,
          }),
        catch: (cause) =>
          new QualityCheckRunnerFileError({
            path: input.worktreeDir,
            operation: "qualityCheckRunner.exec",
            detail:
              cause instanceof Error
                ? cause.message
                : `Failed to execute quality check '${input.check}'.`,
            cause,
          }),
      });

      return {
        check: input.check,
        passed: !execution.timedOut && execution.code === 0,
        output: formatExecutionOutput({
          command: input.config.command,
          timeoutMs: input.config.timeout,
          stdout: execution.stdout,
          stderr: execution.stderr,
          code: execution.code,
          signal: execution.signal,
          timedOut: execution.timedOut,
          sourcePath: input.sourcePath,
        }),
      } satisfies QualityCheckResult;
    },
  );

  const run: QualityCheckRunnerShape["run"] = (input) =>
    Effect.gen(function* () {
      if (input.checks.length === 0) {
        return [];
      }

      const resolved = yield* resolveQualityChecks(input.projectRoot);

      return yield* Effect.forEach(
        input.checks,
        (checkReference) => {
          const entry = resolved.qualityChecks.get(checkReference.check);
          if (!entry) {
            const output =
              resolved.qualityChecks.size === 0
                ? formatMissingConfigOutput(checkReference.check, resolved.searchedPaths)
                : formatMissingCheckOutput(checkReference.check, resolved.searchedPaths);

            return Effect.succeed({
              check: checkReference.check,
              passed: false,
              output,
            } satisfies QualityCheckResult);
          }

          return executeQualityCheck({
            check: checkReference.check,
            config: entry,
            sourcePath: entry.sourcePath,
            worktreeDir: input.worktreeDir,
          });
        },
        { concurrency: 1 },
      );
    });

  return {
    run,
  } satisfies QualityCheckRunnerShape;
});

export const QualityCheckRunnerLive = Layer.effect(QualityCheckRunner, makeQualityCheckRunner());
