import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";

/** Avoid macOS's crowded default parents without moving a caller's chosen test folder. */
export function testTempParent(parent: string, platform = process.platform, home = homedir(), canonicalize: (path: string) => string = realpathSync): string {
  if (platform !== "darwin") return parent;
  let canonical = parent;
  try { canonical = canonicalize(parent); }
  catch { /* A missing custom parent still belongs to the caller. */ }
  const normal = posix.resolve(canonical).replace(/^\/private\//, "/");
  if (normal === "/tmp" || /^\/var\/folders\/[^/]+\/[^/]+\/T$/.test(normal)) return join(home, ".petrina", "test-tmp");
  return parent;
}
