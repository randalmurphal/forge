# Frontend Loop -- Progress Tracker

## Status: IN PROGRESS

## Codebase Patterns

- Frontend query layers can call `getWsRpcClient()` directly when websocket RPC methods exist but `NativeApi` has not exposed them yet.
- New Zustand stores should keep flat state and export pure state transition helpers so most tests stay in fast node-side unit tests.
- React Query hooks should stay thin: fetch a contract-backed payload slice, then mirror successful data into the relevant Zustand store from `useEffect`.

## Known Issues

(Issues found during review phase. Highest severity first.)

## Resolved Issues

(Issues moved here after being fixed and committed.)

## Completed Work Items

- WI-1: Workflow store

## Iteration Log

- 2026-04-06: Completed WI-1 by adding `apps/web/src/stores/workflowStore.ts` with workflow list/detail query hooks, flat editing/selection Zustand state, and workflow cache helpers. Extended `apps/web/src/wsRpcClient.ts` with workflow RPC methods needed by the frontend. Added `apps/web/src/stores/workflowStore.test.ts`. Validation passed: `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.

## Review Log

(Entries added during review phase.)
