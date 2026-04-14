import { useEffect, useState } from "react";

/**
 * Returns an ISO timestamp that updates every second while `active` is true.
 * When `active` is false, the timer stops and the last known value is retained.
 *
 * Components that use this hook will re-render once per second during active periods,
 * so it should be used only in components that need live elapsed-time displays —
 * not in large parent components like ChatView.
 */
export function useNowTick(active: boolean): string {
  const [nowTick, setNowTick] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    // Emit an immediate tick so consumers see the current time
    setNowTick(Date.now());
    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  return new Date(nowTick).toISOString();
}
