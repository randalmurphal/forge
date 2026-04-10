import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2Icon,
  AlertCircleIcon,
  LoaderIcon,
  MonitorIcon,
  GlobeIcon,
  ServerIcon,
} from "lucide-react";

import { APP_DISPLAY_NAME } from "~/branding";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { cn } from "~/lib/utils";

type Tab = "wsl" | "external";

interface ConnectionSetupProps {
  readonly error?: string;
}

function ConnectionSetup({ error }: ConnectionSetupProps) {
  const [tab, setTab] = useState<Tab>("wsl");

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      {/* Background gradient — matches the error/mismatch views */}
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-blue-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-lg rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Connect to Server
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Choose how to connect to a Forge server.
        </p>

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/36 bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Tab selector */}
        <div className="mt-5 flex gap-1 rounded-lg border border-border/70 bg-background/55 p-1">
          <TabButton
            active={tab === "wsl"}
            icon={<MonitorIcon className="size-4" />}
            label="WSL"
            onClick={() => setTab("wsl")}
          />
          <TabButton
            active={tab === "external"}
            icon={<GlobeIcon className="size-4" />}
            label="External Server"
            onClick={() => setTab("external")}
          />
        </div>

        <div className="mt-5">{tab === "wsl" ? <WslSection /> : <ExternalSection />}</div>
      </section>
    </div>
  );
}

function TabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-accent text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// WSL Section
// ---------------------------------------------------------------------------

interface DistroState {
  readonly name: string;
  readonly isDefault: boolean;
  readonly state: string;
  readonly version: number;
}

function WslSection() {
  const bridge = window.desktopBridge;
  if (!bridge) return null;

  const [distros, setDistros] = useState<DistroState[]>([]);
  const [loadingDistros, setLoadingDistros] = useState(true);
  const [distroError, setDistroError] = useState<string | null>(null);
  const [selectedDistro, setSelectedDistro] = useState<string | null>(null);
  const [forgePath, setForgePath] = useState<string | null>(null);
  const [checkingForge, setCheckingForge] = useState(false);
  const [forgeError, setForgeError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Fetch distros on mount
  useEffect(() => {
    let cancelled = false;
    setLoadingDistros(true);
    setDistroError(null);

    bridge
      .getWslDistros()
      .then((result) => {
        if (cancelled) return;
        setDistros(result);
        // Auto-select default distro if one exists
        const defaultDistro = result.find((d) => d.isDefault);
        if (defaultDistro) {
          setSelectedDistro(defaultDistro.name);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDistroError(err instanceof Error ? err.message : "Failed to list WSL distros.");
      })
      .finally(() => {
        if (!cancelled) setLoadingDistros(false);
      });

    return () => {
      cancelled = true;
    };
  }, [bridge]);

  // Check forge when distro is selected
  useEffect(() => {
    if (!selectedDistro) {
      setForgePath(null);
      setForgeError(null);
      return;
    }

    let cancelled = false;
    setCheckingForge(true);
    setForgePath(null);
    setForgeError(null);

    bridge
      .checkWslForge(selectedDistro)
      .then((result) => {
        if (cancelled) return;
        if (result.path) {
          setForgePath(result.path);
        } else {
          setForgeError(
            result.error ??
              `Forge server not found in ${selectedDistro}. Install it inside WSL and try again.`,
          );
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setForgeError(err instanceof Error ? err.message : "Failed to check for Forge binary.");
      })
      .finally(() => {
        if (!cancelled) setCheckingForge(false);
      });

    return () => {
      cancelled = true;
    };
  }, [bridge, selectedDistro]);

  const handleConnect = useCallback(() => {
    if (!selectedDistro || !forgePath) return;
    setConnecting(true);
    setConnectError(null);
    bridge
      .saveConnection({
        mode: "wsl",
        wslDistro: selectedDistro,
        wslForgePath: forgePath,
      })
      .catch((err: unknown) => {
        setConnecting(false);
        setConnectError(err instanceof Error ? err.message : "Connection failed.");
      });
  }, [bridge, selectedDistro, forgePath]);

  if (loadingDistros) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <LoaderIcon className="size-4 animate-spin" />
        Scanning WSL distros…
      </div>
    );
  }

  if (distroError) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/36 bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">
        <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
        <span>{distroError}</span>
      </div>
    );
  }

  if (distros.length === 0) {
    return (
      <p className="py-4 text-sm text-muted-foreground">
        No WSL distributions found. Install a Linux distribution via WSL first.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        {distros.map((distro) => (
          <button
            key={distro.name}
            type="button"
            onClick={() => setSelectedDistro(distro.name)}
            className={cn(
              "flex w-full cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
              selectedDistro === distro.name
                ? "border-primary/50 bg-primary/8 text-foreground"
                : "border-border/70 bg-background/55 text-muted-foreground hover:border-border hover:text-foreground",
            )}
          >
            <ServerIcon className="size-4 shrink-0" />
            <span className="flex-1 font-medium">{distro.name}</span>
            {distro.isDefault && (
              <span className="rounded-sm bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
                default
              </span>
            )}
            {selectedDistro === distro.name && <div className="size-2 rounded-full bg-primary" />}
          </button>
        ))}
      </div>

      {/* Forge binary status */}
      {selectedDistro && (
        <div className="rounded-lg border border-border/70 bg-background/55 px-3 py-2.5 text-sm">
          {checkingForge ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <LoaderIcon className="size-4 animate-spin" />
              Checking for Forge binary…
            </div>
          ) : forgePath ? (
            <div className="flex items-center gap-2 text-success-foreground">
              <CheckCircle2Icon className="size-4 shrink-0" />
              <span>
                Forge found at <code className="text-xs">{forgePath}</code>
              </span>
            </div>
          ) : forgeError ? (
            <div className="flex items-start gap-2 text-destructive-foreground">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
              <span>{forgeError}</span>
            </div>
          ) : null}
        </div>
      )}

      <Button
        size="sm"
        disabled={!forgePath || connecting || forgeError !== null}
        onClick={handleConnect}
      >
        {connecting ? (
          <>
            <LoaderIcon className="size-4 animate-spin" />
            Connecting…
          </>
        ) : (
          "Connect"
        )}
      </Button>

      {connectError && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/36 bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
          <span>{connectError}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// External Server Section
// ---------------------------------------------------------------------------

function ExternalSection() {
  const bridge = window.desktopBridge;
  if (!bridge) return null;

  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState("3773");
  const [token, setToken] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const buildWsUrl = useCallback((): string => {
    const base = `ws://${host}:${port}/ws`;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }, [host, port, token]);

  // Clear test result when inputs change
  useEffect(() => {
    setTestResult(null);
  }, [host, port, token]);

  const handleTest = useCallback(() => {
    const url = buildWsUrl();
    setTesting(true);
    setTestResult(null);

    bridge
      .testConnection(url)
      .then((result) => {
        setTestResult(result);
      })
      .catch((err: unknown) => {
        setTestResult({
          success: false,
          error: err instanceof Error ? err.message : "Connection test failed.",
        });
      })
      .finally(() => {
        setTesting(false);
      });
  }, [bridge, buildWsUrl]);

  const handleConnect = useCallback(() => {
    const url = buildWsUrl();
    setConnecting(true);
    setConnectError(null);
    bridge
      .saveConnection({
        mode: "external",
        externalWsUrl: url,
        externalLabel: host,
      })
      .catch((err: unknown) => {
        setConnecting(false);
        setConnectError(err instanceof Error ? err.message : "Connection failed.");
      });
  }, [bridge, buildWsUrl, host]);

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="conn-host">Host</Label>
          <Input
            id="conn-host"
            value={host}
            placeholder="localhost"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setHost(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="conn-port">Port</Label>
          <Input
            id="conn-port"
            value={port}
            placeholder="3773"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPort(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="conn-token">Auth Token</Label>
          <Input
            id="conn-token"
            value={token}
            placeholder="Optional"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setToken(e.target.value)}
          />
        </div>
      </div>

      {/* Test result */}
      {testResult && (
        <div
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
            testResult.success
              ? "border-success/36 bg-success/8 text-success-foreground"
              : "border-destructive/36 bg-destructive/8 text-destructive-foreground",
          )}
        >
          {testResult.success ? (
            <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" />
          ) : (
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
          )}
          <span>
            {testResult.success
              ? "Connection successful!"
              : (testResult.error ?? "Connection failed.")}
          </span>
        </div>
      )}

      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!host || !port || testing}
          onClick={handleTest}
        >
          {testing ? (
            <>
              <LoaderIcon className="size-4 animate-spin" />
              Testing…
            </>
          ) : (
            "Test Connection"
          )}
        </Button>

        <Button size="sm" disabled={!testResult?.success || connecting} onClick={handleConnect}>
          {connecting ? (
            <>
              <LoaderIcon className="size-4 animate-spin" />
              Connecting…
            </>
          ) : (
            "Connect"
          )}
        </Button>
      </div>

      {connectError && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/36 bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
          <span>{connectError}</span>
        </div>
      )}
    </div>
  );
}

export { ConnectionSetup };
