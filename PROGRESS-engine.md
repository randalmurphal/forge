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
- `WI-12: DeliberationEngine`
- `WI-13: ChannelReactor`
- `WI-14: inputFrom resolution`
- `WI-15: Server composition -- register new services`
- `WI-16: WebSocket RPC handlers for new methods`

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
- `2026-04-05`: Added `DeliberationEngine` with persisted ping-pong turn tracking, participant resolution from channel context, provider-specific stall nudges (`queue` for Claude, `inject` for Codex), mutual-conclusion and max-turn termination signals, reinjection recovery hints for orphaned Codex injections, and direct-write state persistence to `phase_runs` or `projection_threads` as required by the hybrid ownership model. Added focused coverage for turn alternation, stall recovery, mutual conclusion, forced max-turn conclusion, and recovery from persisted chat-session state.
- `2026-04-05`: Added `ChannelReactor` with PubSub-driven handling for `channel.message-posted`, `channel.conclusion-proposed`, and `channel.concluded`; it now advances posting/proposing cursors through `ChannelService`, finalizes mutual or forced deliberation completion through a new internal `channel.mark-concluded` command path, and completes workflow-backed deliberation phases by dispatching `thread.complete-phase` with the formatted channel transcript. Added focused reactor coverage plus the minimal contract/decider additions required to emit the existing `channel.concluded` event through the orchestration engine.
- `2026-04-05`: Added `InputResolver` with support for `phaseName.outputKey`, role-key references like `phaseName.output:role`, and `promoted-from.channel` transcript resolution through `session_links`, plus shared channel transcript formatting and focused coverage for latest-output selection, promoted-session traversal, and invalid or missing references.
- `2026-04-05`: Wired the engine-loop services into server startup by registering the new workflow/channel layers and reactors in `apps/server/src/server.ts`, extending orchestration startup to launch bootstrap/workflow/channel reactors, and fixing layer composition so `runServer` closes over the full runtime graph without leaking `SqlClient` or `ServerSettingsService` requirements.
- `2026-04-05`: Extended the WebSocket contract and server handlers with workflow/channel/session/phase query RPCs, specific workflow and channel push-subscription RPCs, transcript and child-session loaders, workflow create/update persistence paths, and integration coverage in `apps/server/src/server.test.ts` for the new query and subscription surfaces.

## Review Log

(Entries added during review phase.)

- `2026-04-05`: Review pass `Spec Compliance / Code Consistency` found no behavior regressions, but did surface engine-loop lint hygiene issues in the new workflow/channel RPC and resolver code. Cleaned the warnings by hoisting pure `ws.ts` helpers, avoiding `postMessage` lint false positives in channel tests/MCP handlers, and replacing mutation-prone transcript formatting patterns in `InputResolver`. Verification passed with `bun fmt:check`, `bun lint`, `bun typecheck`, and `bun run test`.
- `2026-04-05`: Review pass `Integration Wiring / Dead Code` found the workflow/channel services, reactors, and RPC surfaces fully registered with no orphaned engine-loop code paths. Verified the current tree with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- `2026-04-05`: Review pass `Security` found no new hardening changes required in the engine loop: `QualityCheckRunner` and `BootstrapReactor` only execute project/global Forge config commands and do not interpolate RPC or event payloads into shell command strings. Re-verified the tree with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- `2026-04-05`: Review pass `Error Handling / Test Coverage` surfaced a replay-safety gap in `BootstrapReactor`: duplicate `request.resolved` delivery could previously derive a later bootstrap attempt from historical max-attempt scanning instead of the original bootstrap request id. Fixed the follow-up attempt derivation to stay deterministic per resolved request, added regression coverage for duplicate resolution delivery, and expanded `QualityCheckRunner` coverage for global-config fallback and project-over-global precedence. Re-verified with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
