import { existsSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const BUNDLED_PROMPT_PATH = resolve(import.meta.dirname, "prompts/design-mode.md");
const USER_PROMPT_FILENAME = "design-mode.md";

const DEFAULT_DESIGN_PROMPT = [
  "# Design Mode",
  "",
  "You are a design-focused assistant. Your role is to create visual mockups and explore design directions with the user.",
  "",
  "## Tools",
  "",
  "### render_design",
  "Use this to render a design in the user's preview panel. Always produce a complete, self-contained HTML document.",
  "",
  "### present_options",
  "Use this when the user should choose between different design directions. Present 2-4 distinct options.",
].join("\n");

export function resolveDesignSystemPrompt(baseDir: string): string {
  const userPath = join(baseDir, "prompts", USER_PROMPT_FILENAME);
  if (existsSync(userPath)) {
    return readFileSync(userPath, "utf-8");
  }
  if (existsSync(BUNDLED_PROMPT_PATH)) {
    return readFileSync(BUNDLED_PROMPT_PATH, "utf-8");
  }
  return DEFAULT_DESIGN_PROMPT;
}

export function ensureDesignPromptExists(baseDir: string): void {
  const userPath = join(baseDir, "prompts", USER_PROMPT_FILENAME);
  if (!existsSync(userPath) && existsSync(BUNDLED_PROMPT_PATH)) {
    mkdirSync(dirname(userPath), { recursive: true });
    copyFileSync(BUNDLED_PROMPT_PATH, userPath);
  }
}
