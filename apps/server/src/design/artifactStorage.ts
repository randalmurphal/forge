import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface StoredArtifact {
  readonly artifactId: string;
  readonly artifactPath: string;
  readonly title: string;
  readonly description: string | null;
  readonly createdAt: string;
}

interface ManifestEntry {
  readonly artifactId: string;
  readonly title: string;
  readonly description: string | null;
  readonly createdAt: string;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function manifestPath(artifactsBaseDir: string, threadId: string): string {
  return join(artifactsBaseDir, threadId, "manifest.json");
}

function readManifest(artifactsBaseDir: string, threadId: string): ManifestEntry[] {
  const path = manifestPath(artifactsBaseDir, threadId);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ManifestEntry[];
  } catch (error) {
    console.warn(`Failed to read artifact manifest for thread ${threadId}:`, error);
    return [];
  }
}

function writeManifest(artifactsBaseDir: string, threadId: string, entries: ManifestEntry[]): void {
  const dir = join(artifactsBaseDir, threadId);
  ensureDir(dir);
  writeFileSync(manifestPath(artifactsBaseDir, threadId), JSON.stringify(entries, null, 2));
}

export function storeArtifact(
  artifactsBaseDir: string,
  threadId: string,
  input: { html: string; title: string; description?: string },
): StoredArtifact {
  const artifactId = randomUUID();
  const dir = join(artifactsBaseDir, threadId);
  ensureDir(dir);
  const artifactPath = join(dir, `${artifactId}.html`);
  writeFileSync(artifactPath, input.html, "utf-8");

  const entry: ManifestEntry = {
    artifactId,
    title: input.title,
    description: input.description ?? null,
    createdAt: new Date().toISOString(),
  };
  const manifest = readManifest(artifactsBaseDir, threadId);
  manifest.push(entry);
  writeManifest(artifactsBaseDir, threadId, manifest);

  return {
    artifactId,
    artifactPath,
    title: input.title,
    description: input.description ?? null,
    createdAt: entry.createdAt,
  };
}

export function getArtifactPath(
  artifactsBaseDir: string,
  threadId: string,
  artifactId: string,
): string | null {
  const path = join(artifactsBaseDir, threadId, `${artifactId}.html`);
  return existsSync(path) ? path : null;
}

export function listArtifacts(artifactsBaseDir: string, threadId: string): ManifestEntry[] {
  return readManifest(artifactsBaseDir, threadId);
}
