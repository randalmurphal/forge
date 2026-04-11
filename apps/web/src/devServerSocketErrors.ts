export function isIgnorableDevServerSocketError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? error.code : undefined;
  return code === "ECONNRESET" || code === "ECONNABORTED";
}
