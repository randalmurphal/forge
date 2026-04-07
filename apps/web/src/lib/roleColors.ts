/**
 * Deterministic role-to-color mapping for multi-agent deliberation participants.
 *
 * Uses a fixed palette of visually distinct colors (Tailwind-native values)
 * that work on both light and dark backgrounds. Roles are mapped via a
 * simple string hash so the same role name always resolves to the same color.
 */

const PALETTE: ReadonlyArray<{ light: string; dark: string }> = [
  { light: "#2563eb", dark: "#60a5fa" }, // blue
  { light: "#059669", dark: "#34d399" }, // emerald
  { light: "#ea580c", dark: "#fb923c" }, // orange
  { light: "#7c3aed", dark: "#a78bfa" }, // purple
  { light: "#e11d48", dark: "#fb7185" }, // rose
  { light: "#0d9488", dark: "#2dd4bf" }, // teal
  { light: "#d97706", dark: "#fbbf24" }, // amber
  { light: "#4f46e5", dark: "#818cf8" }, // indigo
  { light: "#0891b2", dark: "#22d3ee" }, // cyan
  { light: "#db2777", dark: "#f472b6" }, // pink
];

function hashRole(role: string): number {
  const normalized = role.toLowerCase().trim();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function resolveRoleColor(role: string, theme: "light" | "dark"): string {
  const index = hashRole(role) % PALETTE.length;
  return PALETTE[index]![theme];
}
