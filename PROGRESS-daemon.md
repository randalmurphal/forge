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

## Iteration Log

- 2026-04-06: Completed WI-1 by switching runtime/base-dir identity to Forge. Replaced `T3CODE_*` envs with `FORGE_*`, defaulted server/desktop/dev tooling to `~/.forge`, updated desktop protocol/app IDs to `forge://` and `com.forgetools.forge`, and added/updated tests covering the new defaults.

## Review Log

(Entries added during review phase.)
