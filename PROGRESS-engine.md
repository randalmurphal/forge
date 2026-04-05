# Engine Loop -- Progress Tracker

## Status: NOT STARTED

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

## Iteration Log

- `2026-04-05`: Implemented `WorkflowRegistry` with startup built-in YAML loading, DB materialization through `ProjectionWorkflowRepository`, query APIs, typed workflow registry errors, and coverage for materialization/precedence/missing workflows. Also fixed workflow projection persistence to preserve `onCompletion` via a new forward migration `025_WorkflowOnCompletion`.

## Review Log

(Entries added during review phase.)
