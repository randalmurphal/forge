import type { DiscussionDefinition, DiscussionScope } from "@forgetools/contracts";
import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { DiscussionRegistryError } from "../Errors.ts";

export type DiscussionEntry = DiscussionDefinition & { readonly scope: DiscussionScope };
export type ManagedDiscussionEntry = DiscussionEntry & { readonly effective: boolean };

export interface DiscussionRegistryShape {
  readonly queryAll: (input: {
    readonly workspaceRoot?: string;
  }) => Effect.Effect<ReadonlyArray<DiscussionEntry>, DiscussionRegistryError>;
  readonly queryByName: (input: {
    readonly name: string;
    readonly workspaceRoot?: string;
  }) => Effect.Effect<Option.Option<DiscussionEntry>, DiscussionRegistryError>;
  readonly queryManagedAll: (input: {
    readonly workspaceRoot?: string;
  }) => Effect.Effect<ReadonlyArray<ManagedDiscussionEntry>, DiscussionRegistryError>;
  readonly queryManagedByName: (input: {
    readonly name: string;
    readonly scope: DiscussionScope;
    readonly workspaceRoot?: string;
  }) => Effect.Effect<Option.Option<DiscussionEntry>, DiscussionRegistryError>;
  readonly create: (input: {
    readonly discussion: DiscussionDefinition;
    readonly scope: DiscussionScope;
    readonly workspaceRoot?: string;
  }) => Effect.Effect<DiscussionEntry, DiscussionRegistryError>;
  readonly update: (input: {
    readonly previousName: string;
    readonly previousScope: DiscussionScope;
    readonly discussion: DiscussionDefinition;
    readonly scope: DiscussionScope;
    readonly workspaceRoot?: string;
  }) => Effect.Effect<DiscussionEntry, DiscussionRegistryError>;
  readonly delete: (input: {
    readonly name: string;
    readonly scope: DiscussionScope;
    readonly workspaceRoot?: string;
  }) => Effect.Effect<void, DiscussionRegistryError>;
}

export class DiscussionRegistry extends ServiceMap.Service<
  DiscussionRegistry,
  DiscussionRegistryShape
>()("forge/discussion/Services/DiscussionRegistry") {}
