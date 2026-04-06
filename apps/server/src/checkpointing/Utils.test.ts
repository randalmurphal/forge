import { describe, expect, it } from "vitest";

import { ThreadId } from "@forgetools/contracts";

import { CHECKPOINT_REFS_PREFIX, checkpointRefForThreadTurn } from "./Utils.ts";

describe("checkpointRefForThreadTurn", () => {
  it("uses the Forge checkpoint ref namespace", () => {
    const checkpointRef = checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-identity"), 3);

    expect(checkpointRef).toMatch(new RegExp(`^${CHECKPOINT_REFS_PREFIX}/[^/]+/turn/3$`, "u"));
    expect(checkpointRef.startsWith("refs/forge/checkpoints/")).toBe(true);
  });
});
