import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./commands.js";
import { tempDir, removeDir } from "./fixtures.js";

export const ADDRESS = "https://github.com/acme/demo.git";

/** A product with a GitHub-like origin: a bare repository and a clone of it, on main. */
export async function makeProduct(root: string): Promise<string> {
  const seed = await repositorySeed(undefined, true);
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");
  mkdirSync(root, { recursive: true });
  cpSync(seed.origin, origin, { recursive: true });
  cpSync(seed.clone, clone, { recursive: true });
  await git(clone, "remote", "set-url", "origin", origin);
  return clone;
}

/** Reuse only the immutable starting commit. Each fixture copies its objects, refs and config. */
interface RepositorySeed { readonly path: string; readonly origin: string; readonly clone: string; readonly head: string }
// Concurrent fixtures asking for one recipe share its preparation while it runs. Only a completed seed is
// ever handed out; a failed one leaves no entry and no folder behind, so the next fixture prepares it afresh.
const repositorySeeds = new Map<string, Promise<RepositorySeed>>();
const seedFolders = new Set<string>();
export function repositorySeed(version?: string, versionFile = false, objectFormat?: "sha1" | "sha256"): Promise<RepositorySeed> {
  const key = JSON.stringify([version ?? "", versionFile, objectFormat]);
  const saved = repositorySeeds.get(key);
  if (saved) return saved;
  const path = tempDir("petrina-repository-seed-");
  seedFolders.add(path);
  const preparing = prepareSeed(path, version, versionFile, objectFormat).catch((error: unknown) => {
    if (repositorySeeds.get(key) === preparing) repositorySeeds.delete(key);
    removeDir(path);
    // A folder that could not be removed yet stays for the exit cleanup.
    if (!existsSync(path)) seedFolders.delete(path);
    throw new Error(`Could not prepare the starting repository in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  });
  repositorySeeds.set(key, preparing);
  return preparing;
}

async function prepareSeed(path: string, version: string | undefined, versionFile: boolean, objectFormat: "sha1" | "sha256" | undefined): Promise<RepositorySeed> {
  const source = join(path, "source"), origin = join(path, "origin.git"), clone = join(path, "clone");
  mkdirSync(source);
  await git(source, "init", "-q", "-b", "main", ...(objectFormat ? [`--object-format=${objectFormat}`] : []));
  writeFileSync(join(source, "README.md"), "# Demo\n");
  if (versionFile) writeFileSync(join(source, "VERSION"), "1.0.0\n");
  if (version) writeFileSync(join(source, "package.json"), `${JSON.stringify({ name: "demo", version }, null, 2)}\n`);
  await git(source, "add", ".");
  await git(source, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init");
  if (versionFile) await git(path, "clone", "-q", "--bare", "--no-hardlinks", source, origin);
  else {
    await git(path, "init", "-q", "--bare", "-b", "main", ...(objectFormat ? [`--object-format=${objectFormat}`] : []), origin);
    await git(source, "push", "-q", origin, "main");
  }
  // Files check out exactly as tests write them, whatever line endings this machine's own Git settings ask for: Git for
  // Windows converts text to CRLF by default. Copies of the clone carry its settings and their linked working copies
  // share them, so Petrina's own Git keeps files as written there too. A test exercising conversion sets its own.
  await git(path, "clone", "-q", "--no-hardlinks", "-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "core.autocrlf=false", "-c", "core.eol=lf", origin, clone);
  if (versionFile) await git(clone, "remote", "set-url", "origin", ADDRESS);
  else {
    // Worlds originally pushed an initial commit to a bare repository by path, without tracking
    // refs or upstream configuration. Product fixtures are real clones and keep those defaults.
    await git(clone, "remote", "remove", "origin");
    await git(clone, "remote", "add", "origin", ADDRESS);
  }
  return Object.freeze({ path, origin, clone, head: await git(source, "rev-parse", "HEAD") });
}
// Standalone diagnostic scripts import these helpers too. The parallel runner owns cleanup when
// Bun's isolated workers bypass exit hooks; ordinary scripts clean their seeds on exit.
process.on("exit", () => { for (const path of seedFolders) removeDir(path); });
