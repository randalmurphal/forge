# Engine Loop -- Progress Tracker

## Status: IN PROGRESS

## Codebase Patterns

- New server services follow `Services/` tags plus `Layers/` live implementations using `Layer.effect(...)`.
- Projection repositories remain the runtime source of truth; higher-level services adapt repository rows into contract shapes rather than bypassing projections.
- Startup materialization belongs in layer construction when the service must be ready-to-query immediately after provisioning.
- Persistence schema changes for existing projections should ship as forward migrations instead of rewriting historical migrations.

## Known Issues

(Issues found during review phase. Highest severity first.)

## Resolved Issues

(Issues moved here after being fixed and committed.)

## Completed Work Items

- `WI-1: WorkflowRegistry service`
- `WI-2: Built-in workflow YAML definitions`
- `WI-3: Built-in prompt templates`

## Iteration Log

- `2026-04-05`: Implemented `WorkflowRegistry` with startup built-in YAML loading, DB materialization through `ProjectionWorkflowRepository`, query APIs, typed workflow registry errors, and coverage for materialization/precedence/missing workflows. Also fixed workflow projection persistence to preserve `onCompletion` via a new forward migration `025_WorkflowOnCompletion`.
- `2026-04-05`: Added the eight built-in workflow YAML definitions under `apps/server/src/workflow/builtins/` and validation coverage that parses every bundled workflow against `WorkflowDefinition`.
- `2026-04-05`: Added bundled prompt templates for all built-in workflow roles under `apps/server/src/workflow/prompts/` plus validation coverage that parses each YAML template and checks placeholder usage against the known engine variable set.

## Review Log

(Entries added during review phase.)
