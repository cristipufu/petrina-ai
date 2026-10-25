import { join, posix } from "node:path";

/** Avoid macOS's crowded default parents without moving a caller's chosen test folder. */
export function testTempParent(parent: string, platform: string, home: string, canonicalize: (path: string) => string): string {
  if (platform !== "darwin") return parent;
  let canonical = parent;
  try { canonical = canonicalize(parent); }
  catch { /* A missing custom parent still belongs to the caller. */ }
  const normal = posix.resolve(canonical).replace(/^\/private\//, "/");
  if (normal === "/tmp" || /^\/var\/folders\/[^/]+\/[^/]+\/T$/.test(normal)) return join(home, ".petrina", "test-tmp");
  return parent;
}
