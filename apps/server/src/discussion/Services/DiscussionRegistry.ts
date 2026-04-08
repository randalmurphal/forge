import type { DiscussionDefinition, DiscussionScope } from "@forgetools/contracts";
import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { DiscussionRegistryError } from "../Errors.ts";

export type DiscussionEntry = DiscussionDefinition & { readonly scope: DiscussionScope };

export interface DiscussionRegistryShape {
  readonly queryAll: (input: {
    readonly workspaceRoot?: string;
  }) => Effect.Effect<ReadonlyArray<DiscussionEntry>, DiscussionRegistryError>;
  readonly queryByName: (input: {
    readonly name: string;
    readonly workspaceRoot?: string;
  }) => Effect.Effect<Option.Option<DiscussionEntry>, DiscussionRegistryError>;
}

export class DiscussionRegistry extends ServiceMap.Service<
  DiscussionRegistry,
  DiscussionRegistryShape
>()("forge/discussion/Services/DiscussionRegistry") {}
