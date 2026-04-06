import { PromptTemplate, TrimmedNonEmptyString } from "@forgetools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PromptResolverError } from "../Errors.ts";

export const ResolvePromptTemplateInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  projectRoot: Schema.optional(Schema.String),
  variables: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type ResolvePromptTemplateInput = typeof ResolvePromptTemplateInput.Type;

export const ApplyPromptTemplateVariablesInput = Schema.Struct({
  template: PromptTemplate,
  variables: Schema.Record(Schema.String, Schema.String),
});
export type ApplyPromptTemplateVariablesInput = typeof ApplyPromptTemplateVariablesInput.Type;

export interface PromptResolverShape {
  readonly resolve: (
    input: ResolvePromptTemplateInput,
  ) => Effect.Effect<PromptTemplate, PromptResolverError>;
  readonly applyVariables: (
    input: ApplyPromptTemplateVariablesInput,
  ) => Effect.Effect<PromptTemplate>;
}

export class PromptResolver extends ServiceMap.Service<PromptResolver, PromptResolverShape>()(
  "forge/workflow/Services/PromptResolver",
) {}
