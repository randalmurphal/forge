import * as path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^~\/(.*)$/,
        replacement: path.resolve(import.meta.dirname, "./apps/web/src/$1"),
      },
      {
        find: /^@forgetools\/contracts$/,
        replacement: path.resolve(import.meta.dirname, "./packages/contracts/src/index.ts"),
      },
    ],
  },
});
