import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { QualityCheckRunner } from "../Services/QualityCheckRunner.ts";
import {
  makeQualityCheckRunner,
  type QualityCheckRunnerLiveOptions,
} from "./QualityCheckRunner.ts";

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "forge-quality-checks-" });
});

const writeTextFile = Effect.fn("QualityCheckRunnerTest.writeTextFile")(function* (
  directory: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(directory, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(Effect.orDie);
  yield* fileSystem.writeFileString(filePath, contents).pipe(Effect.orDie);
});

const nodeCommand = (code: string): string =>
  `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;

const makeQualityCheckRunnerTestLayer = (options: QualityCheckRunnerLiveOptions) =>
  Layer.effect(QualityCheckRunner, makeQualityCheckRunner(options)).pipe(
    Layer.provide(NodeServices.layer),
  );

it.effect("executes a passing quality check in the session worktree", () =>
  Effect.gen(function* () {
    const projectRoot = yield* makeTempDir;
    const worktreeDir = yield* makeTempDir;
    const globalRoot = yield* makeTempDir;
    const globalConfigPath = `${globalRoot}/.forge/config.json`;

    yield* writeTextFile(
      projectRoot,
      ".forge/config.json",
      JSON.stringify({
        qualityChecks: {
          test: {
            command: nodeCommand(
              [
                'const fs = require("node:fs");',
                'fs.writeFileSync("ran.txt", process.cwd());',
                'console.log("quality-pass");',
              ].join(" "),
            ),
          },
        },
      }),
    );

    const [results, ranMarkerExists] = yield* Effect.gen(function* () {
      const runner = yield* QualityCheckRunner;
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;

      const results = yield* runner.run({
        projectRoot,
        worktreeDir,
        checks: [{ check: "test", required: true }],
      });
      const ranMarkerExists = yield* fileSystem.exists(path.join(worktreeDir, "ran.txt"));
      return [results, ranMarkerExists] as const;
    }).pipe(
      Effect.provide(
        makeQualityCheckRunnerTestLayer({
          globalConfigPath,
        }),
      ),
    );

    assert.strictEqual(results.length, 1);
    assert.deepStrictEqual(results[0], {
      check: "test",
      passed: true,
      output: [
        `Source: ${projectRoot}/.forge/config.json`,
        `Command: ${nodeCommand(
          [
            'const fs = require("node:fs");',
            'fs.writeFileSync("ran.txt", process.cwd());',
            'console.log("quality-pass");',
          ].join(" "),
        )}`,
        "Result: passed.",
        "stdout:\nquality-pass",
      ].join("\n\n"),
    });
    assert.strictEqual(ranMarkerExists, true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports failing quality checks with captured stderr output", () =>
  Effect.gen(function* () {
    const projectRoot = yield* makeTempDir;
    const worktreeDir = yield* makeTempDir;
    const globalRoot = yield* makeTempDir;
    const globalConfigPath = `${globalRoot}/.forge/config.json`;

    yield* writeTextFile(
      projectRoot,
      ".forge/config.json",
      JSON.stringify({
        qualityChecks: {
          lint: {
            command: nodeCommand('console.error("quality-fail"); process.exit(2);'),
          },
        },
      }),
    );

    const results = yield* Effect.gen(function* () {
      const runner = yield* QualityCheckRunner;
      return yield* runner.run({
        projectRoot,
        worktreeDir,
        checks: [{ check: "lint", required: true }],
      });
    }).pipe(
      Effect.provide(
        makeQualityCheckRunnerTestLayer({
          globalConfigPath,
        }),
      ),
    );

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]?.check, "lint");
    assert.strictEqual(results[0]?.passed, false);
    assert.ok(results[0]?.output?.includes("Result: failed with exit code 2."));
    assert.ok(results[0]?.output?.includes("stderr:\nquality-fail"));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports timed out quality checks as failures", () =>
  Effect.gen(function* () {
    const projectRoot = yield* makeTempDir;
    const worktreeDir = yield* makeTempDir;
    const globalRoot = yield* makeTempDir;
    const globalConfigPath = `${globalRoot}/.forge/config.json`;

    yield* writeTextFile(
      projectRoot,
      ".forge/config.json",
      JSON.stringify({
        qualityChecks: {
          typecheck: {
            command: nodeCommand("setTimeout(() => process.exit(0), 1000);"),
            timeout: 50,
          },
        },
      }),
    );

    const results = yield* Effect.gen(function* () {
      const runner = yield* QualityCheckRunner;
      return yield* runner.run({
        projectRoot,
        worktreeDir,
        checks: [{ check: "typecheck", required: true }],
      });
    }).pipe(
      Effect.provide(
        makeQualityCheckRunnerTestLayer({
          globalConfigPath,
        }),
      ),
    );

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]?.check, "typecheck");
    assert.strictEqual(results[0]?.passed, false);
    assert.ok(results[0]?.output?.includes("Result: timed out after 50ms."));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("gracefully degrades when no Forge config file exists", () =>
  Effect.gen(function* () {
    const projectRoot = yield* makeTempDir;
    const worktreeDir = yield* makeTempDir;
    const globalRoot = yield* makeTempDir;
    const globalConfigPath = `${globalRoot}/.forge/config.json`;

    const results = yield* Effect.gen(function* () {
      const runner = yield* QualityCheckRunner;
      return yield* runner.run({
        projectRoot,
        worktreeDir,
        checks: [{ check: "test", required: true }],
      });
    }).pipe(
      Effect.provide(
        makeQualityCheckRunnerTestLayer({
          globalConfigPath,
        }),
      ),
    );

    assert.deepStrictEqual(results, [
      {
        check: "test",
        passed: false,
        output: [
          "Quality check 'test' was not executed because no Forge config file was found.",
          `Searched: ${projectRoot}/.forge/config.json, ${globalConfigPath}`,
        ].join("\n"),
      },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns a failed result when the requested quality check key is missing", () =>
  Effect.gen(function* () {
    const projectRoot = yield* makeTempDir;
    const worktreeDir = yield* makeTempDir;
    const globalRoot = yield* makeTempDir;
    const globalConfigPath = `${globalRoot}/.forge/config.json`;

    yield* writeTextFile(
      projectRoot,
      ".forge/config.json",
      JSON.stringify({
        qualityChecks: {
          lint: {
            command: nodeCommand('console.log("lint");'),
          },
        },
      }),
    );

    const results = yield* Effect.gen(function* () {
      const runner = yield* QualityCheckRunner;
      return yield* runner.run({
        projectRoot,
        worktreeDir,
        checks: [{ check: "test", required: true }],
      });
    }).pipe(
      Effect.provide(
        makeQualityCheckRunnerTestLayer({
          globalConfigPath,
        }),
      ),
    );

    assert.deepStrictEqual(results, [
      {
        check: "test",
        passed: false,
        output: [
          "Quality check 'test' is not configured in Forge project config.",
          `Searched: ${projectRoot}/.forge/config.json, ${globalConfigPath}`,
        ].join("\n"),
      },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
