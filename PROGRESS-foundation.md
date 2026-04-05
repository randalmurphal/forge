# Foundation Loop -- Progress Tracker

## Status: IN PROGRESS

## Codebase Patterns

- Contract schema tests use `@effect/vitest` with `it.effect(...)`, `Effect.gen(...)`, and `Schema.decodeUnknownEffect(...)`.
- Branded entity identifiers live in `packages/contracts/src/baseSchemas.ts` and are created with the local `makeEntityId` helper over `TrimmedNonEmptyString`.
- The contracts package exports schema modules through `packages/contracts/src/index.ts`; `baseSchemas.ts` changes do not require additional index wiring.
- New contract domains should live in dedicated files and be exported from `packages/contracts/src/index.ts` rather than extending unrelated schema modules.

## Known Issues

(Issues found during review phase. Highest severity first.)

## Resolved Issues

(Issues moved here after being fixed and committed.)

## Completed Work Items

- WI-1: Branded identifier types
- WI-2: Workflow contract types

## Iteration Log

- 2026-04-05: Implemented WI-1 in contracts by adding the seven new branded entity identifiers and coverage for decode success and empty-string rejection.
- 2026-04-05: Implemented WI-2 by adding workflow, gate, quality check, bootstrap, and project config schemas in `packages/contracts/src/workflow.ts`, exporting them from the contracts index, and adding decode coverage for key workflow unions and defaults.

## Review Log

(Entries added during review phase.)
