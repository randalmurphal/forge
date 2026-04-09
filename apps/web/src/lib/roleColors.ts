import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@forgetools/contracts";
import { resolveRolePalette } from "./appearance";

function hashRole(role: string): number {
  const normalized = role.toLowerCase().trim();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function resolveRoleColor(
  role: string,
  theme: "light" | "dark",
  settings: Pick<ServerSettings, "appearance"> = DEFAULT_SERVER_SETTINGS,
): string {
  const palette = resolveRolePalette(settings, theme);
  const index = hashRole(role) % palette.length;
  return palette[index]!;
}
