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
- WI-2: Channel store
- WI-3: Sidebar tree -- parent/child hierarchy

## Iteration Log

- 2026-04-06: Completed WI-1 by adding `apps/web/src/stores/workflowStore.ts` with workflow list/detail query hooks, flat editing/selection Zustand state, and workflow cache helpers. Extended `apps/web/src/wsRpcClient.ts` with workflow RPC methods needed by the frontend. Added `apps/web/src/stores/workflowStore.test.ts`. Validation passed: `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-06: Completed WI-2 by adding `apps/web/src/stores/channelStore.ts` with flat channel/message cache state, derived deliberation state, pagination/subscription helpers, and React Query hooks for channel detail/message pages. Extended `apps/web/src/wsRpcClient.ts` with channel fetch and push subscription methods used by the store. Added `apps/web/src/stores/channelStore.test.ts`. Validation passed: `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- 2026-04-06: Completed WI-3 by adding `apps/web/src/components/SidebarTree.logic.ts` and `apps/web/src/components/SidebarTree.tsx`, extending sidebar/store thread metadata for parent-child hierarchy rendering, and covering tree derivation in `apps/web/src/components/SidebarTree.logic.test.ts`. Sidebar thread rows now support bounded depth-two expansion, child metadata, propagated parent status, and priority sorting for needs-attention, running, paused, and completed threads. Validation passed: `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.

## Review Log

(Entries added during review phase.)
