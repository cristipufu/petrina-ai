import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { bundledChromiumExecutablePath } from "./bundled-browser.js";
import type { CommandResult } from "@petrina/test-support/commands";
import type { RunObservation } from "@petrina/test-support/run-settlement";
export { observeRun as observeBrowserPrerequisiteCommand } from "@petrina/test-support/run-settlement";

export type BrowserPrerequisiteCommand = RunObservation<CommandResult>;

export type BrowserFileObservation = { kind: "available-file" } | { kind: "missing" } | { kind: "not-file" }
  | { kind: "unavailable"; detail: string };

export interface BrowserExecutableFiles {
  stat(path: string): Promise<{ file: boolean }>;
  access(path: string): Promise<void>;
}
const nativeFiles: BrowserExecutableFiles = {
  async stat(path) { return { file: (await stat(path)).isFile() }; },
  access: path => access(path, constants.R_OK | constants.X_OK),
};
const detail = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** File/access observation only: actual browser launch and system-library checks remain in native tests. */
export async function observeBrowserExecutable(path: string, files: BrowserExecutableFiles = nativeFiles): Promise<BrowserFileObservation> {
  try {
    if (!(await files.stat(path)).file) return { kind: "not-file" };
    await files.access(path);
    return { kind: "available-file" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing" } : { kind: "unavailable", detail: detail(error) };
  }
}

export interface BrowserPrerequisiteEffects {
  executablePath(): string;
  observe(path: string): Promise<BrowserFileObservation>;
}
export async function browserPrerequisite(effects: BrowserPrerequisiteEffects): Promise<BrowserFileObservation & { path: string }> {
  const path = effects.executablePath();
  if (!path) throw new Error("The locked Playwright package did not name a bundled Chromium executable");
  return { ...await effects.observe(path), path };
}

if (import.meta.main) {
  try {
    const result = await browserPrerequisite({ executablePath: bundledChromiumExecutablePath, observe: observeBrowserExecutable });
    if (result.kind !== "available-file") {
      console.error(`The locked Chromium prerequisite is ${result.kind === "missing" ? "not installed" : result.kind === "not-file" ? "not a file" : "unavailable"}.`);
      console.error(`Expected browser: ${result.path}`);
      if (result.kind === "unavailable") console.error(result.detail);
      console.error("Provision it before testing: bun run test:install-browser (on Linux, add --with-deps).");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Could not inspect the locked Chromium prerequisite: ${detail(error)}`);
    console.error("Restore locked dependencies with bun install --frozen-lockfile, then run bun run test:install-browser.");
    process.exitCode = 1;
  }
}
