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

## Completed Work Items

- WI-1: Product identity -- base directory and paths
- WI-2: Product identity -- package names and branding
- WI-3: Daemon process -- startup and singleton discovery

## Iteration Log

- 2026-04-06: Completed WI-1 by switching runtime/base-dir identity to Forge. Replaced `T3CODE_*` envs with `FORGE_*`, defaulted server/desktop/dev tooling to `~/.forge`, updated desktop protocol/app IDs to `forge://` and `com.forgetools.forge`, and added/updated tests covering the new defaults.
- 2026-04-06: Completed WI-2 by renaming workspace packages to `@forgetools/*`, moving the server package/CLI command to `forge`, updating Turbo filters and workspace imports, and replacing remaining Forge-visible `T3 Code` branding across desktop, web, server, marketing, and runtime docs. Verified with `bun fmt`, `bun lint`, `bun typecheck`, `bun run test`, and a product-facing branding grep.
- 2026-04-06: Completed WI-3 by adding `DaemonService` under `apps/server/src/daemon/` with a tagged error surface, startup lock acquisition via `lockf`/`flock` helper processes, PID/socket/`daemon.json` discovery and stale-state cleanup, JSON-RPC `daemon.ping` socket probing, fresh-start manifest generation with `0600` permissions, idempotent stop cleanup, and focused tests covering fresh start, stop cleanup, stale PID recovery, and concurrent singleton startup. Verified with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.

## Review Log

(Entries added during review phase.)
