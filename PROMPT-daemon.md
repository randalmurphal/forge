# Daemon Loop

## Housekeeping

```
Ignore: node_modules/, dist/, .turbo/, coverage/, *.log, bun.lock
```

## Prime Directive

This loop builds forge's daemon mode, socket API, CLI client, OS notifications, Electron lifecycle changes, and product identity switch. This is infrastructure that makes forge a standalone product rather than a t3-code clone.

This loop builds:

- Daemon process management -- separate Node.js process, PID file, flock-based singleton discovery
- Unix socket transport -- JSON-RPC protocol for CLI communication
- CLI client -- `forge` command that talks to the daemon via socket
- Notification dispatch -- OS-native notifications (terminal-notifier on macOS, notify-send on Linux)
- Electron lifecycle change -- app discovers daemon, connects via WebSocket, daemon survives app close
- Product identity -- ~/.forge, forge://, com.forgetools.forge, FORGE\_\* env vars

This loop is INDEPENDENT of Loops 2 and 3. It depends on Loop 1 only for the contract types that define the socket API method signatures.

This loop does NOT modify: workflow engine, channel system, deliberation, or existing orchestration logic.

## Authority Hierarchy

1. design/07-daemon-mode.md (daemon behavior authority)
2. design/13-sessions-first-redesign.md (operational specs -- singleton, transport, startup/shutdown)
3. design/15-contracts.md section 14 (socket API method registry)
4. design/14-implementation-guide.md (codebase patterns)
5. This PROMPT

## Rules of Engagement

- The daemon is ALWAYS a separate process -- never an Electron child. See design/07-daemon-mode.md "Daemon Lifecycle Model"
- Notification dispatch uses argv-based process spawning (execFile with arrays), NEVER shell string interpolation. See design/07-daemon-mode.md "Notification Safety"
- Socket permissions: 0600 (owner-only). PID file at ~/.forge/forge.pid. Socket at ~/.forge/forge.sock. daemon.json with WebSocket port + auth token.
- Electron uses requestSingleInstanceLock() and setAsDefaultProtocolClient('forge')
- Product identity changes are applied as a single atomic pass -- all paths, env vars, app IDs, protocol schemes change together
- The daemon hosts BOTH WebSocket (for app renderer) and Unix socket (for CLI)
- All new daemon code goes in apps/server/src/daemon/ following Services/ + Layers/ pattern
- Electron changes go in apps/desktop/src/main.ts
- CLI goes in a new apps/cli/ package or apps/server/src/cli/

PROHIBITED:

- Spawning the daemon as an Electron child process
- Shell-interpolated notification commands
- Modifying workflow/channel/deliberation code
- Creating UI components (except system tray icon in Electron)

## Environment

- Language: TypeScript
- Runtime: Bun / Node.js
- Framework: Effect.js 4.0.0-beta.43
- Schema: @effect/schema (NOT Zod)
- Test: Vitest
- Working directory: /Users/randy/repos/forge

## Quality Gate

```bash
bun typecheck && bun run test
```

Both must pass. Every commit must pass the quality gate. If typecheck fails, fix the types. If tests fail, fix the tests or the code. NEVER skip the quality gate.

## Workflow Per Iteration

1. Read the progress file for any Known Issues -- fix those FIRST (highest severity)
2. Pick the next uncompleted work item
3. Read the referenced design doc sections
4. Read the relevant existing codebase files to understand patterns
5. Implement the work item following existing patterns exactly
6. Write tests
7. Run quality gate
8. Commit with descriptive message
9. Update progress file (mark item complete, log iteration)
10. Repeat

## Work Items

**WI-1: Product identity -- base directory and paths**

- Spec references: design/13-sessions-first-redesign.md "Product Identity" section
- Target files: apps/server/src/config.ts (MODIFY), apps/desktop/src/main.ts (MODIFY), package.json files
- Deliver: Change all ~/.t3 references to ~/.forge. Change T3CODE*\* env vars to FORGE*\*. Change protocol scheme from t3:// to forge://. Change app user model ID from com.t3tools.t3code to com.forgetools.forge. Ensure forge NEVER reads/writes ~/.t3. Both can coexist on same machine.
- Tests: Config resolves to ~/.forge paths. Env vars use FORGE\_ prefix. Old ~/.t3 paths not referenced.
- Done when: All identity references point to forge, not t3

**WI-2: Product identity -- package names and branding**

- Spec references: design/13-sessions-first-redesign.md product identity section
- Target files: All package.json files, any branding strings in UI/server
- Deliver: Change @t3tools/_ package scope to @forgetools/_ (or remove scope if monorepo-internal). Update any "T3 Code" branding strings to "Forge". Update Electron window titles, about dialogs, CLI help text.
- Tests: `bun typecheck` passes with new package names. No remaining "t3" or "T3" branding strings (except in comments referencing the fork origin).
- Done when: All user-visible branding says "Forge"

**WI-3: Daemon process -- startup and singleton discovery**

- Spec references: design/07-daemon-mode.md "Daemon Lifecycle Model" and "Singleton Discovery and Socket Ownership"
- Target files: NEW apps/server/src/daemon/Services/DaemonService.ts, NEW apps/server/src/daemon/Layers/DaemonService.ts, NEW apps/server/src/daemon/Errors.ts
- Deliver: Service handling daemon lifecycle. On start: acquire flock on ~/.forge/forge.lock, check PID file, ping socket if PID alive, start fresh if stale. On fresh start: bind Unix socket (0600 permissions), write PID file, generate auth token, write daemon.json ({pid, wsPort, wsToken, socketPath, startedAt}). On stop: signal running sessions, wait for graceful shutdown (30s), close socket, remove PID file and daemon.json.
- Tests: Start creates PID + socket + daemon.json. Stop cleans up. Stale PID detected and cleaned. Concurrent start blocked by flock.
- Done when: Daemon singleton lifecycle works end-to-end

**WI-4: Unix socket transport -- JSON-RPC server**

- Spec references: design/13-sessions-first-redesign.md "Daemon Transport", design/15-contracts.md section 14
- Target files: NEW apps/server/src/daemon/Layers/SocketTransport.ts + .test.ts
- Deliver: JSON-RPC 2.0 server over Unix domain socket. Accepts connections, reads newline-delimited JSON requests, dispatches to method handlers, returns JSON responses. Method registry maps socket API methods to OrchestrationEngine commands (see design/15-contracts.md section 14 "Socket Method to Command Mapping"). Auth: socket permissions handle auth (no per-request token needed for Unix socket).
- Tests: Connect to socket, send JSON-RPC request, receive response. Invalid method returns error. Malformed JSON returns parse error.
- Done when: Socket accepts JSON-RPC requests and returns responses

**WI-5: CLI client -- forge command**

- Spec references: design/07-daemon-mode.md "CLI Commands"
- Target files: NEW apps/cli/ package (or apps/server/src/cli/forge.ts)
- Deliver: CLI binary `forge` that connects to ~/.forge/forge.sock and sends JSON-RPC requests. Commands: `forge list` (list sessions), `forge status [session-id]` (session detail), `forge create "title" --workflow build-loop --project .` (create session), `forge correct <session-id> "message"` (post correction), `forge pause/resume/cancel <session-id>`, `forge answer <request-id> --input "..."` (resolve interactive request), `forge daemon start/stop/status`, `forge cleanup` (worktree cleanup). Each command maps to a socket API method, displays results as formatted text.
- Tests: CLI parses arguments correctly. Commands produce valid JSON-RPC requests. Error handling for daemon not running.
- Done when: CLI can manage sessions through the daemon

**WI-6: Notification dispatch**

- Spec references: design/07-daemon-mode.md "Notification Safety" and "Notification Dispatch"
- Target files: NEW apps/server/src/daemon/Services/NotificationDispatch.ts, NEW apps/server/src/daemon/Layers/NotificationDispatch.ts + .test.ts
- Deliver: Service that sends OS notifications. Platform probing: macOS checks for terminal-notifier then osascript, Linux checks for notify-send. Uses execFile with argv arrays (NEVER shell interpolation). Notification contains: title, body, optional click action (forge://session/{id}). Non-fatal -- log errors, fall back to in-app only. Configurable: which events trigger notifications (session needs-attention, session completed, deliberation concluded).
- Tests: macOS notification dispatches correctly. Linux notification dispatches. Missing notifier falls back gracefully. Special characters in title/body don't break commands.
- Done when: OS notifications fire for configured events

**WI-7: Electron lifecycle -- daemon discovery and connection**

- Spec references: design/07-daemon-mode.md "Daemon Lifecycle Model"
- Target files: apps/desktop/src/main.ts (MODIFY)
- Deliver: On app launch: check for running daemon (read daemon.json, ping socket). If daemon running: read wsPort + wsToken, connect renderer to daemon's WebSocket. If no daemon: spawn daemon as detached background process (child_process.spawn with {detached: true, stdio: 'ignore'}, then unref()), wait for daemon.json to appear, connect. On app quit: do NOT kill daemon -- it continues running. Show system tray icon with daemon status. requestSingleInstanceLock() -- second instance sends argv to first via second-instance event. setAsDefaultProtocolClient('forge') -- handle forge://session/{id} deep links via open-url event.
- Tests: App discovers existing daemon. App spawns daemon when none running. Quit doesn't kill daemon. Single instance lock works. Protocol handler registered.
- Done when: Electron app connects to independent daemon, daemon survives app close

**WI-8: Daemon.json auto-discovery for WebSocket**

- Target files: apps/desktop/src/main.ts (MODIFY), apps/desktop/src/preload.ts (MODIFY)
- Deliver: Replace the current hardcoded WebSocket URL (from fd 3 bootstrap) with daemon.json-based discovery. Preload's getWsUrl() reads daemon.json for wsPort + wsToken, returns ws://127.0.0.1:{wsPort}/?token={wsToken}. Handle daemon.json not yet existing (poll briefly on startup while daemon initializes).
- Tests: WS URL resolves from daemon.json. Handles daemon.json appearing after brief delay.
- Done when: Renderer connects to daemon via daemon.json-discovered WebSocket

**WI-9: Server daemon mode runtime**

- Target files: apps/server/src/config.ts (MODIFY), apps/server/src/server.ts (MODIFY)
- Deliver: Add 'daemon' to the RuntimeMode enum (alongside 'web' and 'desktop'). In daemon mode: bind WebSocket on configurable port, bind Unix socket, write daemon.json. Don't auto-open browser (web mode behavior). Don't expect fd 3 bootstrap (desktop mode behavior). Register DaemonService, SocketTransport, and NotificationDispatch in the server Layer composition.
- Tests: Server starts in daemon mode, binds both transports, writes daemon.json.
- Done when: `forge daemon start` launches the server in daemon mode

## Reminders

- This loop is independent of Loops 2-3. It can run in parallel.
- The daemon process is spawned by Electron as a DETACHED process (not a child). Use Node.js child_process.spawn with {detached: true, stdio: 'ignore'} and unref().
- daemon.json file permissions: 0600. Socket file permissions: 0600 (set via fs.chmod after binding).
- The flock on ~/.forge/forge.lock prevents race conditions when two processes try to start the daemon simultaneously.
- Product identity changes touch many files across the monorepo. Use find/grep to ensure no ~/.t3 or T3CODE\_ references remain.
- Notification dispatch MUST use execFile (argv array), not exec (shell string). This prevents command injection from session titles containing shell metacharacters.

## Review Phase

After all work items are complete, enter the review/fix cycle:

1. Check progress file for Known Issues -- fix ALL (highest severity first)
2. If no Known Issues, sweep one review category (see below)
3. Run quality gate, commit all fixes
4. Update progress file
5. Repeat

You NEVER write "Loop Complete" or "Loop Done" in the progress file. The human decides when the loop is done.

Review categories:

1. Spec Compliance -- daemon behavior matches design/07-daemon-mode.md
2. Security -- socket permissions, no shell injection in notifications, auth token handling
3. Test Coverage -- singleton lifecycle, socket protocol, notification edge cases
4. Code Consistency -- Effect.js patterns, Services/Layers structure
5. Dead Code -- all daemon services registered and reachable
6. Integration -- Electron correctly discovers and connects to daemon
7. Product Identity -- no remaining t3/T3/T3CODE references in user-facing code
