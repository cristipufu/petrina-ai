import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix } from "node:path";

/** Where the runner keeps fixtures' private browser folders: test run folders can be too long for browser sockets. */
export const TEST_BROWSERS = "PETRINA_TEST_BROWSERS";

/** A short parent for browser folders, which coding tools' sandboxes also let tests write. Windows has no socket path limit to avoid. */
export function shortTempParent(platform = process.platform, fallback = tmpdir()): string {
  return platform === "win32" ? fallback : "/tmp";
}

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
