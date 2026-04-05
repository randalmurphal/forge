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
- `WI-7: WorkflowEngine service`
- `WI-8: WorkflowReactor`
- `WI-9: ChannelService`
- `WI-10: McpChannelServer`
- `WI-11: Codex channel injection`

## Iteration Log

- `2026-04-05`: Implemented `WorkflowRegistry` with startup built-in YAML loading, DB materialization through `ProjectionWorkflowRepository`, query APIs, typed workflow registry errors, and coverage for materialization/precedence/missing workflows. Also fixed workflow projection persistence to preserve `onCompletion` via a new forward migration `025_WorkflowOnCompletion`.
- `2026-04-05`: Added the eight built-in workflow YAML definitions under `apps/server/src/workflow/builtins/` and validation coverage that parses every bundled workflow against `WorkflowDefinition`.
- `2026-04-05`: Added bundled prompt templates for all built-in workflow roles under `apps/server/src/workflow/prompts/` plus validation coverage that parses each YAML template and checks placeholder usage against the known engine variable set.
- `2026-04-05`: Added `PromptResolver` with project/global/built-in resolution precedence, typed prompt loading/validation errors, and variable substitution that leaves unknown placeholders intact, with coverage for precedence, substitution, and missing-prompt behavior.
- `2026-04-05`: Added `QualityCheckRunner` with project/global Forge config resolution, sequential shell execution in the session worktree, structured pass/fail output capture, timeout handling, and graceful degradation for missing config files or unknown quality-check keys.
- `2026-04-05`: Added `BootstrapReactor` with deterministic bootstrap command ids, git worktree creation under the configured worktree root, project `.forge/config.json` bootstrap command execution with timeout handling, `thread.meta.update` worktree materialization, bootstrap-failed interactive requests with retry/skip handling, and coverage for success, failure, retry, and idempotent replay. Also widened orchestration event-store and command-receipt persistence to accept the full Forge event aggregate set needed for bootstrap request events.
- `2026-04-05`: Added `WorkflowEngine` with deterministic phase-start, quality-check, and gate-request command dispatch, workflow resolution from thread snapshots or the registry, gate evaluation for auto/quality/human flows, retry/advance logic driven from projection state, and focused unit coverage for first-phase start, next-phase advance, quality-check retry, human approval waits, and terminal completion.
- `2026-04-05`: Added `WorkflowReactor` with PubSub-driven workflow lifecycle handling for ready-at-create threads, bootstrap completion, phase completion, and resolved gate requests, plus deterministic/idempotent command dispatch through the orchestration engine. Also extended `WorkflowEngine.advancePhase` with an explicit gate-result override so resolved human gates advance or retry instead of reopening the approval request.
- `2026-04-05`: Added `ChannelService` under `apps/server/src/channel/` with orchestration-backed channel creation and message posting, direct `channel_reads` cursor management that keeps reads pure while advancing the posting agent cursor, typed channel-service errors, and focused coverage for create/post/pagination/unread/cursor/idempotent replay. Also extended `ProjectionChannelMessageRepository` with single-message lookup so replayed posts resolve to the persisted row instead of reconstructing response payloads in memory.
- `2026-04-05`: Added `McpChannelServer` with Claude Agent SDK tool hosting for `post_to_channel`, `read_channel`, and `propose_conclusion`, content-hash replay idempotency backed by `tool_call_results`, mutual-agreement conclusion detection from orchestration history, and focused coverage for tool execution, replay caching, unread reads, and conclusion agreement semantics. Also added a direct `zod` dependency in `apps/server` to satisfy the SDK's MCP tool peer requirement.
- `2026-04-05`: Added `CodexChannelInjection` helpers with deterministic channel-update formatting, exact `PROPOSE_CONCLUSION` parsing, guarded `injectionState` transitions for recovery, and an Effect helper that advances the read cursor at injection time before returning the synthetic user turn payload. Added focused coverage for formatter output, response parsing, reinjection detection, and cursor advancement behavior.

## Review Log

(Entries added during review phase.)
