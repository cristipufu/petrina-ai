import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { testTempParent as tempParentPolicy } from "./temp-parent-policy.js";

/** Where the runner keeps fixtures' private browser folders: test run folders can be too long for browser sockets. */
export const TEST_BROWSERS = "PETRINA_TEST_BROWSERS";

/** A short parent for browser folders, which coding tools' sandboxes also let tests write. Windows has no socket path limit to avoid. */
export function shortTempParent(platform = process.platform, fallback = tmpdir()): string {
  return platform === "win32" ? fallback : "/tmp";
}

/** Supply this machine's path observations to the explicit spelling policy. */
export function testTempParent(parent: string, platform = process.platform, home = homedir(), canonicalize: (path: string) => string = realpathSync): string {
  return tempParentPolicy(parent, platform, home, canonicalize);
}
