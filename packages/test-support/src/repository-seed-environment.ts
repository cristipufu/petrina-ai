import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testGitEnv } from "./test-git-env.js";

export const REPOSITORY_SEEDS = "PETRINA_TEST_REPOSITORY_SEEDS";
const LIMIT = 64 * 1024;
const INPUTS = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "EMAIL"]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Config and completion records are small; unknown or oversized input disables sharing. */
export function seedRecord(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const bytes = Buffer.alloc(LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (!read) return bytes.subarray(0, length).toString("utf8");
      length += read;
    }
    return undefined;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function inputs(environment: NodeJS.ProcessEnv) {
  const env = testGitEnv(environment);
  const values = Object.entries(env).filter(([key, value]) => value !== undefined && (key.toUpperCase().startsWith("GIT_") || INPUTS.has(key.toUpperCase())))
    .map(([key, value]) => [process.platform === "win32" ? key.toUpperCase() : key, value] as const).sort(([a], [b]) => a.localeCompare(b));
  const global = env.GIT_CONFIG_GLOBAL ? seedRecord(env.GIT_CONFIG_GLOBAL) : undefined;
  const system = env.GIT_CONFIG_SYSTEM ? seedRecord(env.GIT_CONFIG_SYSTEM) : undefined;
  // Includes can read changing files outside these snapshots, including conditional paths.
  // Unknown transitive inputs must not reuse even a worker-local preparation promise.
  const includes = (config: string) => /^\s*\[\s*include(?:if)?(?:\s|\.|\])/im.test(config);
  // Without both explicit files, Git may read unobserved home/system configuration.
  const identity = global !== undefined && system !== undefined && !includes(global) && !includes(system)
    ? digest(JSON.stringify([values, global, system])) : undefined;
  return { env, global, system, identity };
}

/** Every runner/nested environment owns its cache; preparation reads immutable config snapshots. */
export function provisionRepositorySeeds(folder: string, env: NodeJS.ProcessEnv): string {
  const root = join(folder, "repository-seeds"), current = inputs(env);
  if (!current.identity || current.global === undefined || current.system === undefined) throw new Error("Repository seeds require the runner's explicit private Git configuration");
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(root, "global.gitconfig"), current.global, { mode: 0o600 });
  writeFileSync(join(root, "system.gitconfig"), current.system, { mode: 0o600 });
  writeFileSync(join(root, "environment.json"), JSON.stringify({ version: 1, identity: current.identity, global: digest(current.global), system: digest(current.system) }), { mode: 0o600 });
  return root;
}

/** Resolve anew before consulting the module cache: changed config or PATH cannot reuse an earlier promise. */
export function repositorySeedEnvironment(environment: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; identity?: string; shared?: string } {
  const current = inputs(environment), root = environment[REPOSITORY_SEEDS];
  // Fallback Git reads live config files. Without immutable snapshots a cached promise
  // could retain a repository built after those files changed under an older identity.
  const local = { env: current.env };
  if (!root || !current.identity) return local;
  try {
    const text = seedRecord(join(root, "environment.json"));
    if (!text) return local;
    const saved = JSON.parse(text) as { version?: unknown; identity?: unknown; global?: unknown; system?: unknown };
    const global = seedRecord(join(root, "global.gitconfig")), system = seedRecord(join(root, "system.gitconfig"));
    if (saved.version !== 1 || saved.identity !== current.identity || global === undefined || system === undefined
      || saved.global !== digest(global) || saved.system !== digest(system)) return local;
    return { identity: current.identity, shared: root,
      env: { ...current.env, GIT_CONFIG_GLOBAL: join(root, "global.gitconfig"), GIT_CONFIG_SYSTEM: join(root, "system.gitconfig") } };
  } catch { return local; }
}
