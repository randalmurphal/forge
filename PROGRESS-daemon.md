# Daemon Loop -- Progress Tracker

## Status: IN PROGRESS

## Codebase Patterns

- Runtime identity and env resolution are centralized in `apps/server/src/cli.ts`, `apps/server/src/os-jank.ts`, and `scripts/dev-runner.ts`.
- Desktop process identity is owned in `apps/desktop/src/main.ts`; desktop build-time bundle identity is mirrored in `apps/desktop/scripts/electron-launcher.mjs` and `scripts/build-desktop-artifact.ts`.
- Shared runtime env filtering and propagation must be kept in sync across `apps/server/src/terminal/Layers/Manager.ts`, `apps/web/src/projectScripts.ts`, and `packages/shared/src/shell.ts`.

## Known Issues

(Issues found during review phase. Highest severity first.)

## Resolved Issues

(Issues moved here after being fixed and committed.)

- 2026-04-06: Fixed a desktop/daemon bootstrap race found during the Integration review sweep. Tray clicks, tray menu activation, and app re-activation could create a renderer window before daemon discovery finished, which let the desktop shell load without a valid daemon WebSocket URL and fall back to `forge://app` as the server origin. The fix gates new desktop window creation on daemon WebSocket readiness, keeps deep links queued until the daemon is ready, and adds focused desktop coverage for the readiness guard.
- 2026-04-06: Fixed dead daemon notification wiring found during the Dead Code review sweep. `NotificationDispatch` was registered in daemon mode but never subscribed to orchestration events, so OS notifications could not fire outside unit tests. The fix adds a daemon-only `NotificationReactor`, starts it from the daemon runtime, filters notifications to top-level sessions and standalone deliberations, and adds focused reactor plus runtime coverage for the live trigger paths.
- 2026-04-06: Fixed daemon manifest parsing drift found during the Code Consistency review sweep. Desktop and CLI/server each had their own `daemon.json` parser and trust checks, which made the acceptance rules diverge and increased the risk of future review regressions. The fix extracts shared manifest parsing/trust helpers into `@forgetools/shared/daemon`, rewires desktop and CLI/server readers to use the shared path, and adds regression coverage for malformed empty-field manifests in shared, desktop, and server tests.
- 2026-04-06: Fixed a daemon manifest trust gap found during the Security review sweep. Desktop and CLI were accepting any readable `daemon.json` contents without validating owner-only permissions or the expected Forge socket path, which could trust a stale or tampered WebSocket token manifest. The fix adds shared daemon-manifest validation, enforces `0600` manifest permissions before token use on supported platforms, verifies `socketPath` matches the expected `~/.forge/forge.sock`, and adds regression coverage in shared, desktop, and server tests.
- 2026-04-06: Fixed a daemon startup readiness race discovered during the Spec Compliance review sweep. The Unix socket could answer `daemon.ping` before the daemon WebSocket listener was actually accepting connections, which let desktop discovery succeed and then race a dead `ws://127.0.0.1:{port}` on first connect. The fix exposes HTTP-listener readiness from `ServerRuntimeStartup`, gates daemon socket RPC execution on that readiness, and adds regression coverage for delayed `daemon.ping` responses until the runtime is ready.
- 2026-04-06: Fixed a JSON-RPC notification handling gap found during the Test Coverage review sweep. The daemon socket transport was incorrectly emitting error responses for notification requests without an `id`, which violates JSON-RPC 2.0 and could confuse fire-and-forget daemon clients. The fix suppresses unknown-method and invalid-params responses for true notifications, adds regression coverage for silent notification failures, and adds a shutdown-order test proving `daemon.stop` responds before the async stop hook runs.

## Completed Work Items

- WI-1: Product identity -- base directory and paths
- WI-2: Product identity -- package names and branding
- WI-3: Daemon process -- startup and singleton discovery
- WI-4: Unix socket transport -- JSON-RPC server
- WI-5: CLI client -- forge command
- WI-6: Notification dispatch
- WI-7: Electron lifecycle -- daemon discovery and connection
- WI-8: Daemon.json auto-discovery for WebSocket
- WI-9: Server daemon mode runtime

## Iteration Log

- 2026-04-06: Completed WI-1 by switching runtime/base-dir identity to Forge. Replaced `T3CODE_*` envs with `FORGE_*`, defaulted server/desktop/dev tooling to `~/.forge`, updated desktop protocol/app IDs to `forge://` and `com.forgetools.forge`, and added/updated tests covering the new defaults.
- 2026-04-06: Completed WI-2 by renaming workspace packages to `@forgetools/*`, moving the server package/CLI command to `forge`, updating Turbo filters and workspace imports, and replacing remaining Forge-visible `T3 Code` branding across desktop, web, server, marketing, and runtime docs. Verified with `bun fmt`, `bun lint`, `bun typecheck`, `bun run test`, and a product-facing branding grep.
- 2026-04-06: Completed WI-3 by adding `DaemonService` under `apps/server/src/daemon/` with a tagged error surface, startup lock acquisition via `lockf`/`flock` helper processes, PID/socket/`daemon.json` discovery and stale-state cleanup, JSON-RPC `daemon.ping` socket probing, fresh-start manifest generation with `0600` permissions, idempotent stop cleanup, and focused tests covering fresh start, stop cleanup, stale PID recovery, and concurrent singleton startup. Verified with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-06: Completed WI-4 by adding a daemon `SocketTransport` service/layer that binds a `0600` Unix socket, parses newline-delimited JSON-RPC 2.0 requests, maps the socket method registry onto orchestration/channel/workflow operations, and returns structured JSON-RPC errors for parse, invalid-request, invalid-params, and unknown-method failures. Added focused socket transport tests for success, method-not-found, parse errors, and channel intervention dispatch. Verified with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-06: Completed WI-5 by adding a Forge CLI JSON-RPC client with detached daemon startup/status helpers, socket-path and daemon manifest resolution, empty worktree cleanup, and user-facing `forge` commands for session lifecycle, interactive answers, cleanup, and `daemon start|stop|status`. Added CLI routing tests for core commands and the missing-daemon error path, then verified with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-06: Completed WI-6 by adding a daemon `NotificationDispatch` service/layer with typed Forge notification triggers, settings-backed notification preferences, argv-only backend execution for `terminal-notifier`, `osascript`, and `notify-send`, explicit `forge://session/{id}` click metadata where supported, and non-fatal fallback logging when desktop notification delivery is unavailable or fails. Added focused notification dispatch tests for macOS, Linux, missing backend, disabled triggers, special-character payloads, and exec failures, plus server-settings coverage for the new notification toggles. Verified with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-06: Completed WI-7 by refactoring Electron startup around daemon discovery instead of an fd-3 child backend: `main.ts` now acquires the single-instance lock, registers `forge://` protocol handling, discovers or detached-spawns the daemon from `daemon.json`, routes deep links into the renderer, keeps the daemon alive across app quit, and exposes tray status for the background runtime. Added focused desktop lifecycle tests covering discovery, detached launch, protocol parsing, second-instance handling, and quit behavior. Verified with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-06: Completed WI-8 by moving desktop WebSocket discovery into preload-side `daemon.json` resolution instead of a main-process IPC cache, extracting shared desktop daemon-state helpers for path/info parsing, priming a short startup poll so delayed daemon manifests are picked up automatically, and removing the now-unused `desktop:get-ws-url` IPC path. Added desktop tests covering `~/.forge` path resolution, manifest parsing, and delayed `daemon.json` appearance for preload URL discovery. Verified with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-06: Completed WI-9 by adding server-side `daemon` runtime mode support, daemon-mode CLI defaults, and a dedicated daemon runtime layer that starts the singleton daemon services, binds both transports, materializes notifications, and shuts down cleanly on `daemon.stop` without interrupting the JSON-RPC response path. Added daemon runtime and config tests covering duplicate-launch detection, shutdown wiring, and daemon-mode auth/defaults. Verified with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.

## Review Log

(Entries added during review phase.)

- 2026-04-06: Review Category 5 -- Dead Code. Found the daemon notification path was effectively dead because `NotificationDispatch` was only materialized, never subscribed to real orchestration events. Added a daemon-only notification reactor, wired it into daemon startup, filtered out child-session and phase-deliberation noise, and verified the fix with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-06: Review Category 1 -- Spec Compliance. Verified daemon/desktop lifecycle behavior against `design/07-daemon-mode.md` and fixed the daemon readiness race so socket discovery now reflects actual WebSocket availability. Verified with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-06: Review Category 2 -- Security. Tightened daemon manifest trust so desktop/CLI only accept owner-only `daemon.json` files whose `socketPath` matches Forge's expected socket, reducing stale-manifest and local tampering exposure around `wsToken`. Verified with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-06: Review Category 3 -- Test Coverage. Expanded daemon socket transport coverage to include JSON-RPC notification semantics and `daemon.stop` response ordering, and fixed the transport so no-id notifications no longer receive error responses. Verified with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-06: Review Category 4 -- Code Consistency. Removed duplicated `daemon.json` parsing/trust logic across shared, desktop, and CLI/server code by extracting a single shared manifest helper path and reusing it everywhere daemon state is read. Verified with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-06: Review Category 6 -- Integration. Fixed a desktop startup race where tray/menu/app activation could open a renderer window before daemon bootstrap completed, causing the shell to fall back to `forge://app` instead of a daemon WebSocket endpoint. Added a readiness guard for new window creation, kept protocol navigation queued until the daemon is ready, and verified with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-06: Review Category 7 -- Product Identity. Removed remaining Forge-visible T3 identity leaks across marketing/release metadata, desktop build artifacts, Codex client naming, and browser-persisted storage keys; added legacy local-storage migration so existing `t3code:*` client state is adopted into `forge:*` keys without losing preferences or drafts. Verified with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
