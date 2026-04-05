# Foundation Loop -- Progress Tracker

## Status: IN PROGRESS

## Codebase Patterns

- Contract schema tests use `@effect/vitest` with `it.effect(...)`, `Effect.gen(...)`, and `Schema.decodeUnknownEffect(...)`.
- Branded entity identifiers live in `packages/contracts/src/baseSchemas.ts` and are created with the local `makeEntityId` helper over `TrimmedNonEmptyString`.
- The contracts package exports schema modules through `packages/contracts/src/index.ts`; `baseSchemas.ts` changes do not require additional index wiring.
- New contract domains should live in dedicated files and be exported from `packages/contracts/src/index.ts` rather than extending unrelated schema modules.
- When additive command schemas outpace runtime support, keep the existing `OrchestrationCommand` and client RPC command unions stable and stage the expanded surface behind `ForgeCommand` until decider/engine handling is added.

## Known Issues

(Issues found during review phase. Highest severity first.)

## Resolved Issues

(Issues moved here after being fixed and committed.)

## Completed Work Items

- WI-1: Branded identifier types
- WI-2: Workflow contract types
- WI-3: Channel contract types
- WI-4: Interactive request contract types
- WI-5: New command types
- WI-6: New event types
- WI-7: Database migrations -- workflow and phase tables
- WI-8: Database migrations -- channel tables

## Iteration Log

- 2026-04-05: Implemented WI-1 in contracts by adding the seven new branded entity identifiers and coverage for decode success and empty-string rejection.
- 2026-04-05: Implemented WI-2 by adding workflow, gate, quality check, bootstrap, and project config schemas in `packages/contracts/src/workflow.ts`, exporting them from the contracts index, and adding decode coverage for key workflow unions and defaults.
- 2026-04-05: Implemented WI-3 by adding channel entities, deliberation state schemas, and channel contract tests covering channel message decoding and deliberation defaults.
- 2026-04-05: Implemented WI-4 by adding `packages/contracts/src/interactiveRequest.ts`, exporting the new interactive request schemas from the contracts index with a root-level alias for the new `UserInputQuestion` helper to avoid colliding with the existing provider-runtime export, and adding discriminated-union decode coverage for all payload and resolution variants.
- 2026-04-05: Implemented WI-5 by extracting shared provider/model schemas into `packages/contracts/src/providerSchemas.ts`, adding the additive workflow/channel/request command schemas plus `ForgeCommand` to `packages/contracts/src/orchestration.ts`, preserving the legacy `OrchestrationCommand` runtime surface for existing engine exhaustiveness, and adding round-trip coverage for every new command schema.
- 2026-04-05: Implemented WI-6 by adding additive workflow, channel, and interactive-request event payload schemas plus `ForgeEventType`/`ForgeEvent` in `packages/contracts/src/orchestration.ts`, keeping the legacy `OrchestrationEvent` surface intact, renaming the new request event payload exports to avoid a provider-runtime barrel collision, and adding round-trip coverage for every new Forge event variant.
- 2026-04-05: Implemented WI-7 by adding migration `020_WorkflowTables` for `workflows` and `phase_runs`, registering it in the migration loader, adding an in-memory migration test that verifies the new tables and indexes, and confirming `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` all pass with the migration in place.
- 2026-04-05: Implemented WI-8 by adding migration `021_ChannelTables` for `channels`, `channel_messages`, `channel_reads`, and `tool_call_results`, registering it in the migration loader, adding an in-memory migration test that verifies the new tables, indexes, and composite keys, and confirming `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` all pass with the migration in place.

## Review Log

(Entries added during review phase.)
