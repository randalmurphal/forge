import * as FS from "node:fs";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = Path.resolve(import.meta.dirname, "../../..");

describe("product identity", () => {
  it("uses Forge for the composer editor namespace", () => {
    const source = FS.readFileSync(
      Path.join(repoRoot, "apps/web/src/components/ComposerPromptEditor.tsx"),
      "utf8",
    );

    expect(source).toContain('namespace: "forge-composer-editor"');
    expect(source).not.toContain("t3tools-composer-editor");
  });

  it("uses the Forge package scope in the shared Vitest alias", () => {
    const source = FS.readFileSync(Path.join(repoRoot, "vitest.config.ts"), "utf8");

    expect(source).toContain("find: /^@forgetools\\/contracts$/");
    expect(source).not.toContain("@t3tools\\/contracts");
  });
});
