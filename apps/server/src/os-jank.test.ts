import os from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Path } from "effect";

import { resolveBaseDir } from "./os-jank";

it.layer(NodeServices.layer)("resolveBaseDir", (it) => {
  it.effect("defaults to ~/.forge when unset", () =>
    Effect.gen(function* () {
      const { basename, join } = yield* Path.Path;
      const baseDir = yield* resolveBaseDir(undefined);

      assert.equal(baseDir, join(os.homedir(), ".forge"));
      assert.equal(basename(baseDir), ".forge");
    }),
  );

  it.effect("expands and resolves explicit home-relative paths", () =>
    Effect.gen(function* () {
      const { join, resolve } = yield* Path.Path;
      const baseDir = yield* resolveBaseDir("~/workspace/.forge-alt");

      assert.equal(baseDir, resolve(join(os.homedir(), "workspace/.forge-alt")));
    }),
  );
});
