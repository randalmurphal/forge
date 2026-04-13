import {
  type InteractiveRequest,
  type InteractiveRequestId,
  type PermissionRequestPayload,
  type PermissionRequestResolution,
} from "@forgetools/contracts";
import { memo, useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Switch } from "../ui/switch";
import { cn } from "~/lib/utils";

interface PermissionRequest extends InteractiveRequest {
  type: "permission";
  payload: PermissionRequestPayload;
}

export type ComposerPendingPermissionRequest = PermissionRequest;

interface ComposerPendingPermissionPanelProps {
  request: PermissionRequest;
  pendingCount: number;
  isResponding: boolean;
  onRespond: (
    requestId: InteractiveRequestId,
    resolution: PermissionRequestResolution,
  ) => Promise<void>;
}

function toggleStringValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

export const ComposerPendingPermissionPanel = memo(function ComposerPendingPermissionPanel({
  request,
  pendingCount,
  isResponding,
  onRespond,
}: ComposerPendingPermissionPanelProps) {
  const requestedReadPaths = request.payload.permissions.fileSystem?.read ?? null;
  const requestedWritePaths = request.payload.permissions.fileSystem?.write ?? null;
  const requestedNetworkEnabled = request.payload.permissions.network?.enabled ?? null;

  const [scope, setScope] = useState<"turn" | "session">("turn");
  const [selectedReadPaths, setSelectedReadPaths] = useState<string[]>(
    Array.from(requestedReadPaths ?? []),
  );
  const [selectedWritePaths, setSelectedWritePaths] = useState<string[]>(
    Array.from(requestedWritePaths ?? []),
  );
  const [networkEnabled, setNetworkEnabled] = useState<boolean>(requestedNetworkEnabled ?? false);

  useEffect(() => {
    setScope("turn");
    setSelectedReadPaths(Array.from(requestedReadPaths ?? []));
    setSelectedWritePaths(Array.from(requestedWritePaths ?? []));
    setNetworkEnabled(requestedNetworkEnabled ?? false);
  }, [request.id, requestedNetworkEnabled, requestedReadPaths, requestedWritePaths]);

  const grantedPermissions = useMemo(() => {
    const fileSystem =
      selectedReadPaths.length > 0 || selectedWritePaths.length > 0
        ? {
            read: selectedReadPaths.length > 0 ? selectedReadPaths : null,
            write: selectedWritePaths.length > 0 ? selectedWritePaths : null,
          }
        : undefined;
    const network = networkEnabled ? { enabled: true } : undefined;

    return {
      scope,
      permissions: {
        ...(fileSystem ? { fileSystem } : {}),
        ...(network ? { network } : {}),
      },
    };
  }, [networkEnabled, scope, selectedReadPaths, selectedWritePaths]);

  const submitResolution = async () => {
    await onRespond(request.id, grantedPermissions);
  };

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">PERMISSION REQUEST</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
      <p className="mt-1.5 text-sm text-foreground/90">
        {request.payload.reason ?? "The agent is requesting broader filesystem or network access."}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant={scope === "turn" ? "default" : "outline"}
          disabled={isResponding}
          onClick={() => setScope("turn")}
        >
          This turn
        </Button>
        <Button
          type="button"
          size="sm"
          variant={scope === "session" ? "default" : "outline"}
          disabled={isResponding}
          onClick={() => setScope("session")}
        >
          This session
        </Button>
      </div>

      <div className="mt-4 space-y-3">
        <div className="rounded-xl border border-border/70 bg-background/50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Network access</div>
              <div className="text-xs text-muted-foreground">
                {requestedNetworkEnabled === null
                  ? "No network request details were provided."
                  : requestedNetworkEnabled
                    ? "Grant network access for this request."
                    : "Network access was not requested."}
              </div>
            </div>
            <Switch
              checked={networkEnabled}
              disabled={isResponding}
              onCheckedChange={(checked) => setNetworkEnabled(Boolean(checked))}
            />
          </div>
        </div>

        <PermissionPathSection
          title="Filesystem read access"
          paths={requestedReadPaths}
          selectedPaths={selectedReadPaths}
          disabled={isResponding}
          onTogglePath={(path) =>
            setSelectedReadPaths((current) => toggleStringValue(current, path))
          }
        />

        <PermissionPathSection
          title="Filesystem write access"
          paths={requestedWritePaths}
          selectedPaths={selectedWritePaths}
          disabled={isResponding}
          onTogglePath={(path) =>
            setSelectedWritePaths((current) => toggleStringValue(current, path))
          }
        />
      </div>

      <div className="mt-4 flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="default"
          disabled={isResponding}
          onClick={() => void submitResolution()}
        >
          Grant selected access
        </Button>
      </div>
    </div>
  );
});

interface PermissionPathSectionProps {
  title: string;
  paths: readonly string[] | null;
  selectedPaths: string[];
  disabled: boolean;
  onTogglePath: (path: string) => void;
}

function PermissionPathSection({
  title,
  paths,
  selectedPaths,
  disabled,
  onTogglePath,
}: PermissionPathSectionProps) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/50 p-3">
      <div className="text-sm font-medium">{title}</div>
      {paths && paths.length > 0 ? (
        <div className="mt-2 space-y-2">
          {paths.map((path) => (
            <label
              key={path}
              className={cn(
                "flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors",
                disabled ? "opacity-70" : "hover:bg-muted/40",
              )}
            >
              <Checkbox
                checked={selectedPaths.includes(path)}
                disabled={disabled}
                onCheckedChange={() => onTogglePath(path)}
              />
              <span className="min-w-0 flex-1 break-all text-foreground/85">{path}</span>
            </label>
          ))}
        </div>
      ) : (
        <div className="mt-1 text-xs text-muted-foreground">No paths were requested.</div>
      )}
    </div>
  );
}
