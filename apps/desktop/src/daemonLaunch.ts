import * as Path from "node:path";

export interface DesktopBackendLaunchSpec {
  readonly entryScriptPath: string;
  readonly execPath: string;
}

export function resolveDesktopBackendLaunchSpec(input: {
  readonly appRoot: string;
  readonly isDevelopment: boolean;
}): DesktopBackendLaunchSpec {
  if (input.isDevelopment) {
    // In desktop dev mode the renderer is rebuilt live, but the detached daemon is started by the
    // Electron main process. Point that daemon at the server source entry so a plain
    // `bun run dev:desktop` picks up server RPC changes immediately instead of reconnecting to an
    // older dist bundle that still happens to be healthy.
    return {
      entryScriptPath: Path.join(input.appRoot, "apps/server/src/bin.ts"),
      execPath: "bun",
    };
  }

  return {
    entryScriptPath: Path.join(input.appRoot, "apps/server/dist/bin.mjs"),
    execPath: "node",
  };
}
