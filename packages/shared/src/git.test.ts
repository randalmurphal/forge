import { describe, expect, it } from "vitest";

import { buildForgePrefixedBranchName, isForgeTemporaryWorktreeBranch } from "./git";

describe("isForgeTemporaryWorktreeBranch", () => {
  describe("default prefix", () => {
    it("matches a valid forge temporary branch", () => {
      expect(isForgeTemporaryWorktreeBranch("forge/a1b2c3d4")).toBe(true);
    });

    it("matches another valid 8-hex suffix", () => {
      expect(isForgeTemporaryWorktreeBranch("forge/abcdef12")).toBe(true);
    });

    it("rejects non-hex characters in the suffix", () => {
      expect(isForgeTemporaryWorktreeBranch("forge/not-hex-!")).toBe(false);
    });

    it("rejects a suffix that is too long", () => {
      expect(isForgeTemporaryWorktreeBranch("forge/a1b2c3d4e5")).toBe(false);
    });

    it("rejects a different prefix", () => {
      expect(isForgeTemporaryWorktreeBranch("other/a1b2c3d4")).toBe(false);
    });
  });

  describe("custom prefix", () => {
    it("matches when the branch uses the custom prefix", () => {
      expect(isForgeTemporaryWorktreeBranch("myteam/a1b2c3d4", "myteam")).toBe(true);
    });

    it("rejects the default prefix when a custom prefix is specified", () => {
      expect(isForgeTemporaryWorktreeBranch("forge/a1b2c3d4", "myteam")).toBe(false);
    });
  });

  describe("regex metacharacter escaping in prefix", () => {
    it("matches a prefix containing a literal dot", () => {
      expect(isForgeTemporaryWorktreeBranch("my.team/a1b2c3d4", "my.team")).toBe(true);
    });

    it("does not treat dot as a wildcard", () => {
      expect(isForgeTemporaryWorktreeBranch("myXteam/a1b2c3d4", "my.team")).toBe(false);
    });
  });

  describe("case insensitivity", () => {
    it("matches uppercase input against the default prefix", () => {
      expect(isForgeTemporaryWorktreeBranch("FORGE/A1B2C3D4")).toBe(true);
    });
  });

  describe("whitespace trimming", () => {
    it("trims surrounding whitespace before matching", () => {
      expect(isForgeTemporaryWorktreeBranch(" forge/a1b2c3d4 ")).toBe(true);
    });
  });
});

describe("buildForgePrefixedBranchName", () => {
  it("builds a branch name with the default forge prefix", () => {
    expect(buildForgePrefixedBranchName("fix-login")).toBe("forge/fix-login");
  });

  it("builds a branch name with a custom prefix", () => {
    expect(buildForgePrefixedBranchName("fix-login", "myteam")).toBe("myteam/fix-login");
  });

  it("sanitizes the fragment with a custom prefix", () => {
    expect(buildForgePrefixedBranchName("Fix Login!", "myteam")).toBe("myteam/fix-login");
  });
});
