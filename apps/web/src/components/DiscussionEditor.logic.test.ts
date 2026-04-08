import { describe, expect, it } from "vitest";

import {
  createEmptyDiscussionDefinition,
  sortManagedDiscussionsForEditor,
  validateDiscussionDraft,
} from "./DiscussionEditor.logic";

describe("discussion editor draft helpers", () => {
  it("creates an empty discussion draft with two participants", () => {
    const draft = createEmptyDiscussionDefinition();

    expect(draft.name).toBe("");
    expect(draft.participants).toHaveLength(2);
    expect(draft.settings.maxTurns).toBe(20);
  });

  it("sorts project discussions ahead of global discussions", () => {
    const sorted = sortManagedDiscussionsForEditor([
      {
        name: "global-discussion",
        description: "",
        participantRoles: ["advocate", "critic"],
        scope: "global",
        effective: true,
      },
      {
        name: "project-discussion",
        description: "",
        participantRoles: ["advocate", "critic"],
        scope: "project",
        effective: true,
      },
    ]);

    expect(sorted.map((discussion) => discussion.name)).toEqual([
      "project-discussion",
      "global-discussion",
    ]);
  });

  it("flags exact scope conflicts for new drafts", () => {
    const baseDraft = createEmptyDiscussionDefinition({
      provider: "codex",
      model: "gpt-5.4",
    });
    const participants = [
      Object.assign({}, baseDraft.participants[0], { system: "Argue for" }),
      Object.assign({}, baseDraft.participants[1], { system: "Argue against" }),
    ];
    const draft = {
      ...baseDraft,
      name: "debate",
      participants,
    };

    expect(
      validateDiscussionDraft({
        draft,
        scope: "project",
        selectedProjectId: "project-1",
        existingDiscussions: [
          {
            name: "debate",
            description: "",
            participantRoles: ["advocate", "critic"],
            scope: "project",
            effective: true,
          },
        ],
        routeDiscussionName: null,
        routeScope: null,
      }),
    ).toBe("A project discussion named 'debate' already exists.");
  });
});
