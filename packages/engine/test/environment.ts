import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { shortTempParent, testTempParent, TEST_BROWSERS } from "./temp-parent.js";
import { fixtureFiles } from "./fixture-files.js";

export const TEST_GIT_IDENTITY = { name: "Petrina Test Runner", email: "test-runner@example.com" };

/** Only OS/runtime necessities and explicit test controls cross the outer runner boundary. */
const INHERITED = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "OS", "NUMBER_OF_PROCESSORS",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "CI",
  // Bun changes its result output when running under an agent. Preserve that behavior without account settings.
  "CLAUDECODE", "AGENT", "REPL_ID", "PETRINA_FIXTURE_RUN", "PETRINA_BROWSER_CHECK", "PETRINA_CONTAINER_CHECK", "PETRINA_CONTAINER_IMAGE",
]);

/** The one configuration used by fixture Git and by the engine's own Git in fresh clones. */
export function writeTestGitConfig(folder: string): string {
  const file = join(folder, "gitconfig");
  writeFileSync(file, `[user]\n\tname = ${TEST_GIT_IDENTITY.name}\n\temail = ${TEST_GIT_IDENTITY.email}\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n\teol = lf\n[commit]\n\tgpgSign = false\n[tag]\n\tgpgSign = false\n`, { mode: 0o600 });
  return file;
}

/** Playwright's provisioned binary cache is the only developer-home content exposed to a run. */
function browserCache(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const parent = process.platform === "darwin" ? join(home, "Library", "Caches")
    : process.platform === "win32" ? env.LOCALAPPDATA ?? join(home, "AppData", "Local")
    : env.XDG_CACHE_HOME ?? join(home, ".cache");
  return join(parent, "ms-playwright");
}

/**
 * Construct once before workers start; never mutate their global environment during a test. The caller
 * owns `folder` and removes it after workers stop. Nested runs have independent homes and Git settings.
 */
export function testEnvironment(folder: string, browsers: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (INHERITED.has(key.toUpperCase()) || /^PETRINA_TEST_/.test(key)
      || inherited.PETRINA_CONTAINER_CHECK && /^(DOCKER|CONTAINER|PODMAN)_/.test(key)) env[key] = value;
  }
  const home = join(folder, "home"), config = join(home, ".config"), cache = join(home, ".cache");
  const local = join(home, "AppData", "Local"), roaming = join(home, "AppData", "Roaming");
  for (const path of [home, config, cache, local, roaming]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const empty = join(folder, "empty-gitconfig"); writeFileSync(empty, "", { mode: 0o600 });
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local,
    XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, XDG_DATA_HOME: join(home, ".local", "share"),
    TMPDIR: folder, TMP: folder, TEMP: folder, PETRINA_HOME: home, [TEST_BROWSERS]: browsers,
    GIT_CONFIG_GLOBAL: writeTestGitConfig(folder), GIT_CONFIG_SYSTEM: empty, GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never",
  });
  const provisioned = browserCache(inherited), isolated = browserCache(env);
  if (existsSync(provisioned)) {
    mkdirSync(dirname(isolated), { recursive: true });
    fixtureFiles.directoryLink(fixtureFiles.canonical(provisioned), isolated);
  }
  return env;
}

/** Shared ownership for the complete runner and focused engine runner, including partial startup failures. */
export function createTestRun(): { env: NodeJS.ProcessEnv; close(): void } {
  const parent = testTempParent(tmpdir());
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const folder = mkdtempSync(join(parent, "petrina-tests-"));
  let browsers: string | undefined;
  const close = () => {
    try { rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    finally { if (browsers) rmSync(browsers, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  };
  try {
    browsers = mkdtempSync(join(shortTempParent(process.platform, folder), "pb-"));
    return { env: testEnvironment(folder, browsers), close };
  } catch (error) { close(); throw error; }
}
