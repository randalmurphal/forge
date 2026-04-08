import type {
  DiscussionDefinition,
  DiscussionManagedSummary,
  DiscussionScope,
  ModelSelection,
} from "@forgetools/contracts";

export const DEFAULT_DISCUSSION_MAX_TURNS = 20;

function cloneModelSelection(selection: ModelSelection): ModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}

export function createEmptyDiscussionDefinition(
  defaultModelSelection?: ModelSelection,
): DiscussionDefinition {
  return {
    name: "",
    description: "",
    participants: [
      {
        role: "advocate",
        description: "Argues for the current direction.",
        system: "",
        ...(defaultModelSelection ? { model: cloneModelSelection(defaultModelSelection) } : {}),
      },
      {
        role: "critic",
        description: "Presses on weak spots and risks.",
        system: "",
        ...(defaultModelSelection ? { model: cloneModelSelection(defaultModelSelection) } : {}),
      },
    ],
    settings: {
      maxTurns: DEFAULT_DISCUSSION_MAX_TURNS,
    },
  };
}

export function ensureDiscussionHasExplicitParticipantModels(
  discussion: DiscussionDefinition,
  defaultModelSelection: ModelSelection,
): DiscussionDefinition {
  return {
    ...discussion,
    participants: discussion.participants.map((participant) => ({
      ...participant,
      model: participant.model
        ? cloneModelSelection(participant.model)
        : cloneModelSelection(defaultModelSelection),
    })),
  };
}

function discussionScopeRank(scope: DiscussionScope): number {
  return scope === "project" ? 0 : 1;
}

export function sortManagedDiscussionsForEditor(
  discussions: readonly DiscussionManagedSummary[],
): DiscussionManagedSummary[] {
  return [...discussions].toSorted((left, right) => {
    const scopeDifference = discussionScopeRank(left.scope) - discussionScopeRank(right.scope);
    if (scopeDifference !== 0) {
      return scopeDifference;
    }

    if (left.effective !== right.effective) {
      return left.effective ? -1 : 1;
    }

    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

export function validateDiscussionDraft(input: {
  draft: DiscussionDefinition | null;
  scope: DiscussionScope;
  selectedProjectId: string | null;
  existingDiscussions: readonly DiscussionManagedSummary[];
  routeDiscussionName: string | null;
  routeScope: DiscussionScope | null;
}): string | null {
  const { draft } = input;
  if (!draft) {
    return "Discussion draft is unavailable.";
  }

  const trimmedName = draft.name.trim();
  if (trimmedName.length === 0) {
    return "Add a discussion name.";
  }

  if (input.scope === "project" && input.selectedProjectId === null) {
    return "Choose a project for this discussion.";
  }

  if (draft.participants.length < 2) {
    return "Add at least two participants.";
  }

  for (const participant of draft.participants) {
    if (participant.role.trim().length === 0) {
      return "Each participant needs a role.";
    }
    if (!participant.model) {
      return `Choose a provider and model for '${participant.role || "participant"}'.`;
    }
    if (participant.system.trim().length === 0) {
      return `Add a system prompt for '${participant.role || "participant"}'.`;
    }
  }

  if (!Number.isInteger(draft.settings.maxTurns) || draft.settings.maxTurns < 1) {
    return "Max turns must be at least 1.";
  }

  const hasExactConflict = input.existingDiscussions.some(
    (discussion) =>
      discussion.scope === input.scope &&
      discussion.name.localeCompare(trimmedName, undefined, { sensitivity: "base" }) === 0 &&
      !(
        input.routeDiscussionName !== null &&
        input.routeScope === input.scope &&
        input.routeDiscussionName.localeCompare(trimmedName, undefined, {
          sensitivity: "base",
        }) === 0
      ),
  );
  if (hasExactConflict) {
    return `A ${input.scope} discussion named '${trimmedName}' already exists.`;
  }

  return null;
}
