# Foundation Loop -- Progress Tracker

## Status: IN PROGRESS

## Codebase Patterns

- Contract schema tests use `@effect/vitest` with `it.effect(...)`, `Effect.gen(...)`, and `Schema.decodeUnknownEffect(...)`.
- Branded entity identifiers live in `packages/contracts/src/baseSchemas.ts` and are created with the local `makeEntityId` helper over `TrimmedNonEmptyString`.
- The contracts package exports schema modules through `packages/contracts/src/index.ts`; `baseSchemas.ts` changes do not require additional index wiring.
- New contract domains should live in dedicated files and be exported from `packages/contracts/src/index.ts` rather than extending unrelated schema modules.
- When additive command schemas outpace runtime support, keep the existing `OrchestrationCommand` and client RPC command unions stable and stage the expanded surface behind `ForgeCommand` until decider/engine handling is added.
- Persistence repository tests that share an `it.layer(...)` suite can observe rows created by earlier tests; scope assertions to the rows under test or use a fresh layer when isolation matters.
- Multi-repository persistence tests that must share one SQLite database should merge the repository live layers first and provide `SqlitePersistenceMemory` once to the merged layer; independently pre-providing the in-memory layer risks separate databases.

## Known Issues

(Issues found during review phase. Highest severity first.)

## Resolved Issues

(Issues moved here after being fixed and committed.)

- 2026-04-05: Spec compliance gap in bootstrap lifecycle coverage: `design/15-contracts.md` defines the additive `thread.bootstrap-queued` event and queued bootstrap state, but the Forge event union and projector only handled started/completed/failed/skipped, so queued bootstrap sessions could not be represented in the read model.
- 2026-04-05: Spec compliance gap in the additive channel surface: `channel.read-messages` was defined in contracts, but the decider did not emit the matching `channel.messages-read` event and the projection pipeline never updated `channel_reads`, leaving the read-cursor path unreachable despite the schema and table existing.
- 2026-04-05: Spec compliance gap in push-event contracts: section 7 of `design/15-contracts.md` defines workflow/channel push event payload schemas, but the contracts package did not expose `WorkflowPushEvent`/`ChannelPushEvent` or their typed variants, leaving that documented schema surface unavailable to later loops.
- 2026-04-05: Error handling gap in the new JSON-backed foundation projection repositories: malformed stored JSON in workflow, phase-run, phase-output, channel-message, and interactive-request projections was being surfaced as `PersistenceSqlError` instead of the existing `PersistenceDecodeError`, which would have obscured corruption/shape regressions during projection reads.

## Completed Work Items

- WI-1: Branded identifier types
- WI-2: Workflow contract types
- WI-3: Channel contract types
- WI-4: Interactive request contract types
- WI-5: New command types
- WI-6: New event types
- WI-7: Database migrations -- workflow and phase tables
- WI-8: Database migrations -- channel tables
- WI-9: Database migrations -- thread extensions
- WI-10: Database migrations -- phase outputs and other tables
- WI-11: Projection repositories -- workflows
- WI-12: Projection repositories -- phase runs
- WI-13: Projection repositories -- channels and messages
- WI-14: Projection repositories -- phase outputs
- WI-15: Projection repository -- interactive requests
- WI-16: Decider extensions -- workflow commands
- WI-17: Decider extensions -- channel commands
- WI-18: Decider extensions -- interactive request commands
- WI-19: Projector extensions -- workflow events
- WI-20: Projector extensions -- channel events
- WI-21: Projector extensions -- request events
- WI-22: Read model extensions
- WI-23: ProjectionPipeline extensions

## Iteration Log

- 2026-04-05: Implemented WI-1 in contracts by adding the seven new branded entity identifiers and coverage for decode success and empty-string rejection.
- 2026-04-05: Implemented WI-2 by adding workflow, gate, quality check, bootstrap, and project config schemas in `packages/contracts/src/workflow.ts`, exporting them from the contracts index, and adding decode coverage for key workflow unions and defaults.
- 2026-04-05: Implemented WI-3 by adding channel entities, deliberation state schemas, and channel contract tests covering channel message decoding and deliberation defaults.
- 2026-04-05: Implemented WI-4 by adding `packages/contracts/src/interactiveRequest.ts`, exporting the new interactive request schemas from the contracts index with a root-level alias for the new `UserInputQuestion` helper to avoid colliding with the existing provider-runtime export, and adding discriminated-union decode coverage for all payload and resolution variants.
- 2026-04-05: Implemented WI-5 by extracting shared provider/model schemas into `packages/contracts/src/providerSchemas.ts`, adding the additive workflow/channel/request command schemas plus `ForgeCommand` to `packages/contracts/src/orchestration.ts`, preserving the legacy `OrchestrationCommand` runtime surface for existing engine exhaustiveness, and adding round-trip coverage for every new command schema.
- 2026-04-05: Implemented WI-6 by adding additive workflow, channel, and interactive-request event payload schemas plus `ForgeEventType`/`ForgeEvent` in `packages/contracts/src/orchestration.ts`, keeping the legacy `OrchestrationEvent` surface intact, renaming the new request event payload exports to avoid a provider-runtime barrel collision, and adding round-trip coverage for every new Forge event variant.
- 2026-04-05: Implemented WI-7 by adding migration `020_WorkflowTables` for `workflows` and `phase_runs`, registering it in the migration loader, adding an in-memory migration test that verifies the new tables and indexes, and confirming `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` all pass with the migration in place.
- 2026-04-05: Implemented WI-8 by adding migration `021_ChannelTables` for `channels`, `channel_messages`, `channel_reads`, and `tool_call_results`, registering it in the migration loader, adding an in-memory migration test that verifies the new tables, indexes, and composite keys, and confirming `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` all pass with the migration in place.
- 2026-04-05: Implemented WI-9 by adding migration `022_ThreadExtensions` for the new thread projection columns and parent/phase indexes, registering it in the migration loader, adding an in-memory migration test that verifies the new columns plus compatibility with preexisting thread rows, and confirming `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` all pass with the migration in place.
- 2026-04-05: Implemented WI-10 by adding migration `023_PhaseOutputTables` for `phase_outputs`, `session_synthesis`, `session_dependencies`, `session_links`, `phase_run_provenance`, `phase_run_outcomes`, `project_knowledge`, and `attention_signals`, registering it in the migration loader, adding an in-memory migration test that verifies the new tables plus their required indexes and partial unique indexes, and confirming `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` all pass with the migration in place.
- 2026-04-05: Implemented WI-11 by adding `ProjectionWorkflows` service and layer for CRUD access to the `workflows` table with typed `phases_json` decoding and user-workflow precedence in `queryByName`, adding in-memory CRUD coverage for `queryAll`, `queryById`, `queryByName`, `upsert`, and `delete`, and confirming `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` all pass.
- 2026-04-05: Implemented WI-12 by adding `ProjectionPhaseRuns` service and layer for persisted phase-run CRUD/status updates with typed JSON decoding for gate results, quality-check results, and deliberation state, adding in-memory repository coverage for `queryById`, `queryByThreadId`, `upsert`, and `updateStatus`, and confirming `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` all pass.
- 2026-04-05: Implemented WI-13 by adding `ProjectionChannels`, `ProjectionChannelMessages`, and `ProjectionChannelReads` services and layers for channel creation/status updates, forward-paginated channel message reads, unread counts backed by `channel_reads`, and cursor upserts; added in-memory repository coverage for channel CRUD, message pagination/unread counts, and read cursor persistence; and confirmed `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` all pass.
- 2026-04-05: Implemented WI-14 by adding `ProjectionPhaseOutputs` service and layer for persisted phase-output upserts plus composite-key queries with typed `metadata_json` decoding, adding in-memory CRUD coverage for `queryByPhaseRunId`, `queryByKey`, and idempotent composite-key upserts, and confirming `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` all pass.
- 2026-04-05: Implemented WI-15 by adding migration `024_InteractiveRequests` for the missing `interactive_requests` projection table and indexes, adding `ProjectionInteractiveRequests` service and layer for persisted interactive-request CRUD/status transitions with typed JSON decoding for payload and resolution unions, adding in-memory repository coverage for `queryByThreadId`, `queryById`, `queryPending`, `upsert`, `updateStatus`, and `markStale`, and confirming `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` all pass.
- 2026-04-05: Implemented WI-16 by extending the orchestration decider with the staged workflow-thread command surface (`thread.correct`, phase lifecycle, quality checks, bootstrap, links, promotion, and dependencies), widening command invariants to the staged Forge command subset with new same-project/distinct-thread helpers, adding focused decider coverage for valid emissions and invariant failures in `decider.workflow.test.ts`, and confirming `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` all pass.
- 2026-04-05: Implemented WI-17 by extending the orchestration decider with additive channel command handling for create/post-message/conclude/close, adding typed channel invariants plus minimal read-model channel state needed for validation, deriving deterministic channel message sequences from the orchestration snapshot cursor, adding focused decider coverage in `decider.channelRequest.test.ts`, and confirming `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` all pass.
- 2026-04-05: Implemented WI-18 by extending the orchestration decider with additive interactive-request command handling for open/resolve/mark-stale, adding pending-request invariants plus minimal read-model request state for validation, covering the new request flows and invariant failures in `decider.channelRequest.test.ts`, and confirming `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` all pass.
- 2026-04-05: Implemented WI-19 by extending the orchestration projector to accept the staged Forge event surface, adding workflow event handlers for phase lifecycle, quality checks, bootstrap state, corrections, links, dependencies, promotion, and synthesis with additive projected workflow state (`phaseRuns`, link/dependency tracking, and future-aligned thread fields), adding focused workflow projection coverage in `projector.test.ts`, and confirming `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` all pass.
- 2026-04-05: Implemented WI-20 by extending the orchestration projector with additive channel event handling for create/post-message/conclusion/close, updating projected thread timestamps plus promotion parent-child relationships, and adding focused projector coverage for channel state transitions in `projector.test.ts`.
- 2026-04-05: Implemented WI-21 by extending the orchestration projector with additive interactive-request event handling for open/resolve/stale, keeping the read model’s `pendingRequests` set truly pending-only, and adding focused projector coverage for request lifecycle removal in `projector.test.ts`.
- 2026-04-05: Implemented WI-22 by extending `OrchestrationThread` and `OrchestrationReadModel` with the additive workflow/read-model fields from the contracts spec, wiring the new defaults through existing server and web snapshot fixtures, and confirming `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` all pass against the widened schema surface.
- 2026-04-05: Implemented WI-23 by widening the projection pipeline to the staged Forge event surface, registering new phase-run/channel/channel-message/phase-output plus interactive-request projectors and repositories, adding pipeline coverage that exercises the new projection tables through `projectEvent`, and confirming `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` all pass.

## Review Log

(Entries added during review phase.)

- 2026-04-05: Swept `Spec Compliance` again and restored the missing additive `thread.bootstrap-queued` contract/event path by adding the queued bootstrap payload and Forge event variant, exporting the server schema alias, teaching the projector to materialize `bootstrapStatus: "queued"`, adding contract round-trip coverage plus a projector regression test, and verifying `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-05: Swept `Spec Compliance` and fixed the missing `channel.read-messages` flow by adding the `channel.messages-read` event contract/payload, extending the decider to emit it with same-project validation, teaching the projector to accept it, wiring a dedicated `channel_reads` projector into `ProjectionPipeline`, and adding contract/decider/projector/pipeline coverage. Verified with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-05: Swept `Spec Compliance` and filled the missing workflow/channel push-event contract surface from section 7 of `design/15-contracts.md` by adding `WorkflowPhaseEvent`, `WorkflowQualityCheckEvent`, `WorkflowBootstrapEvent`, `WorkflowGateEvent`, `WorkflowPushEvent`, `ChannelMessageEvent`, `ChannelConclusionEvent`, `ChannelStatusEvent`, and `ChannelPushEvent` to `packages/contracts/src/orchestration.ts`, plus round-trip coverage in `packages/contracts/src/orchestration.test.ts`. Verified with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-05: Swept `Error Handling` and restored decode-vs-SQL error classification across the new JSON-backed foundation projection repositories by adding a shared `toPersistenceSqlOrDecodeError` helper, routing workflow/phase-run/phase-output/channel-message/interactive-request read paths through it, and adding malformed-JSON regression coverage for each repository. Verified with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
