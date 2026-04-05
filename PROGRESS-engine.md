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
- `WI-4: Prompt resolution`
- `WI-5: QualityCheckRunner service`
- `WI-6: BootstrapReactor`

## Iteration Log

- `2026-04-05`: Implemented `WorkflowRegistry` with startup built-in YAML loading, DB materialization through `ProjectionWorkflowRepository`, query APIs, typed workflow registry errors, and coverage for materialization/precedence/missing workflows. Also fixed workflow projection persistence to preserve `onCompletion` via a new forward migration `025_WorkflowOnCompletion`.
- `2026-04-05`: Added the eight built-in workflow YAML definitions under `apps/server/src/workflow/builtins/` and validation coverage that parses every bundled workflow against `WorkflowDefinition`.
- `2026-04-05`: Added bundled prompt templates for all built-in workflow roles under `apps/server/src/workflow/prompts/` plus validation coverage that parses each YAML template and checks placeholder usage against the known engine variable set.
- `2026-04-05`: Added `PromptResolver` with project/global/built-in resolution precedence, typed prompt loading/validation errors, and variable substitution that leaves unknown placeholders intact, with coverage for precedence, substitution, and missing-prompt behavior.
- `2026-04-05`: Added `QualityCheckRunner` with project/global Forge config resolution, sequential shell execution in the session worktree, structured pass/fail output capture, timeout handling, and graceful degradation for missing config files or unknown quality-check keys.
- `2026-04-05`: Added `BootstrapReactor` with deterministic bootstrap command ids, git worktree creation under the configured worktree root, project `.forge/config.json` bootstrap command execution with timeout handling, `thread.meta.update` worktree materialization, bootstrap-failed interactive requests with retry/skip handling, and coverage for success, failure, retry, and idempotent replay. Also widened orchestration event-store and command-receipt persistence to accept the full Forge event aggregate set needed for bootstrap request events.

## Review Log

(Entries added during review phase.)
