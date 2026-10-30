import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitWith } from "./commands.js";
import { tempDir, removeDir } from "./fixtures.js";
import { headNow } from "./repository-head.js";
import { repositorySeedEnvironment, seedRecord } from "./repository-seed-environment.js";
import { privateOriginConfig } from "./repository-config.js";

export const ADDRESS = "https://github.com/acme/demo.git";

export interface ProductRepository {
  readonly path: string;
  /** The copied immutable seed commit, never a claim about later mutable HEAD. */
  readonly initialSha: string;
}

/** A private writable copy whose initial commit was observed while preparing its immutable seed. */
export async function createProductRepository(root: string, options: {
  origin?: "private" | "none";
  objectFormat?: "sha1" | "sha256"
} = {}): Promise<ProductRepository> {
  const seed = await repositorySeed(undefined, true, options.objectFormat, options.origin === "none" ? "none" : "github");
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");
  mkdirSync(root, { recursive: true });
  if (options.origin !== "none") cpSync(seed.origin, origin, { recursive: true });
  cpSync(seed.clone, clone, { recursive: true });
  if (options.origin !== "none") {
    const config = join(clone, ".git", "config");
    writeFileSync(config, privateOriginConfig(readFileSync(config, "utf8"), ADDRESS, origin));
  }
  return Object.freeze({ path: clone, initialSha: seed.head });
}

/** A product with a GitHub-like origin: a bare repository and a clone of it, on main. */
export async function makeProduct(root: string, options: { origin?: "private" | "none"; objectFormat?: "sha1" | "sha256" } = {}): Promise<string> {
  return (await createProductRepository(root, options)).path;
}

/** Reuse only the immutable starting commit. Each fixture copies its objects, refs and config. */
interface RepositorySeed { readonly path: string; readonly origin: string; readonly clone: string; readonly head: string }
// Canonical runner fixtures share each immutable recipe's preparation. Unknown environments prepare afresh.
// Only a completed seed is handed out; a failed preparation leaves no reusable entry or folder behind.
const repositorySeeds = new Map<string, Promise<RepositorySeed>>();
const seedFolders = new Set<string>();
export function repositorySeed(version?: string, versionFile = false, objectFormat?: "sha1" | "sha256", origin: "github" | "none" = "github"): Promise<RepositorySeed> {
  const recipe = JSON.stringify([1, version ?? "", versionFile, objectFormat, origin]);
  const environment = repositorySeedEnvironment(process.env);
  const key = JSON.stringify([recipe, environment.shared ?? null, environment.identity ?? randomUUID()]);
  const saved = repositorySeeds.get(key);
  if (saved) return saved;
  const published = environment.shared ? join(environment.shared, createHash("sha256").update(recipe).digest("hex")) : undefined;
  if (published) {
    const ready = publishedSeed(published, recipe);
    if (ready) {
      const value = Promise.resolve(ready);
      repositorySeeds.set(key, value);
      return value;
    }
  }
  const preparing = (async (): Promise<RepositorySeed> => {
    const claim = published ? await claimSeedPreparation(`${published}.claim`, published, recipe) : undefined;
    if (claim?.kind === "ready") return claim.seed;
    const path = environment.shared ? mkdtempSync(join(environment.shared, ".prepare-")) : tempDir("petrina-repository-seed-");
    seedFolders.add(path);
    try {
      const seed = await prepareSeed(path, version, versionFile, objectFormat, origin, environment.env);
      if (!published) return seed;
      // Publish the completed repository and its record together; bounded claim fallback keeps readers non-blocking if a peer stalls.
      writeFileSync(join(path, "complete.json"), JSON.stringify({ recipe, head: seed.head }));
      try { renameSync(path, published); }
      catch (error) {
        const winner = publishedSeed(published, recipe);
        if (!winner) throw error;
        removeDir(path);
        if (existsSync(path)) throw new Error("Could not remove this worker's unused repository preparation");
        seedFolders.delete(path);
        return winner;
      }
      seedFolders.delete(path); // The runner owns published data until every worker has settled.
      return Object.freeze({ path: published, origin: join(published, "origin.git"), clone: join(published, "clone"), head: seed.head });
    } catch (error: unknown) {
      removeDir(path);
      // A folder that could not be removed yet stays for the exit cleanup.
      if (!existsSync(path)) seedFolders.delete(path);
      throw new Error(`Could not prepare the starting repository in ${path}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (claim?.kind === "claimed") claim.release();
    }
  })().catch((error: unknown) => {
    if (repositorySeeds.get(key) === preparing) repositorySeeds.delete(key);
    throw error;
  });
  repositorySeeds.set(key, preparing);
  return preparing;
}

async function claimSeedPreparation(
  claimPath: string,
  published: string,
  recipe: string,
): Promise<{ kind: "ready"; seed: RepositorySeed } | { kind: "claimed"; release(): void } | { kind: "fallback" }> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const ready = publishedSeed(published, recipe);
    if (ready) return { kind: "ready", seed: ready };
    try {
      mkdirSync(claimPath);
      try { writeFileSync(join(claimPath, "pid"), String(process.pid)); } catch {}
      return { kind: "claimed", release: () => rmSync(claimPath, { recursive: true, force: true }) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") return { kind: "fallback" };
      const ownerText = seedRecord(join(claimPath, "pid"));
      const ownerPid = ownerText ? Number(ownerText.trim()) : NaN;
      if (Number.isInteger(ownerPid) && ownerPid > 0) {
        try { process.kill(ownerPid, 0); }
        catch (probeError) {
          if ((probeError as NodeJS.ErrnoException | undefined)?.code === "ESRCH") {
            rmSync(claimPath, { recursive: true, force: true });
            continue;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const ready = publishedSeed(published, recipe);
  return ready ? { kind: "ready", seed: ready } : { kind: "fallback" };
}

function publishedSeed(path: string, recipe: string): RepositorySeed | undefined {
  const text = seedRecord(join(path, "complete.json"));
  if (!text) return undefined;
  const saved = JSON.parse(text) as { recipe?: unknown; head?: unknown };
  if (saved.recipe !== recipe || typeof saved.head !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(saved.head)
    || !["source", "origin.git", "clone"].every(folder => statSync(join(path, folder)).isDirectory()))
    throw new Error(`Invalid completed repository seed in ${path}`);
  return Object.freeze({ path, origin: join(path, "origin.git"), clone: join(path, "clone"), head: saved.head });
}

async function prepareSeed(path: string, version: string | undefined, versionFile: boolean, objectFormat: "sha1" | "sha256" | undefined, remote: "github" | "none", env: NodeJS.ProcessEnv): Promise<RepositorySeed> {
  const git = (cwd: string, ...args: string[]) => gitWith({ cwd, env }, ...args);
  const source = join(path, "source");
  const origin = join(path, "origin.git");
  const clone = join(path, "clone");
  mkdirSync(source);
  await git(source, "init", "-q", "-b", "main", ...(objectFormat ? [`--object-format=${objectFormat}`] : []));
  writeFileSync(join(source, "README.md"), "# Demo\n");
  if (versionFile) writeFileSync(join(source, "VERSION"), "1.0.0\n");
  if (version) writeFileSync(join(source, "package.json"), `${JSON.stringify({ name: "demo", version }, null, 2)}\n`);
  await git(source, "add", ".");
  await git(source, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init");
  const head = headNow(source);
  cpSync(join(source, ".git"), origin, { recursive: true });
  rmSync(join(origin, "index"), { force: true });
  rmSync(join(origin, "logs"), { recursive: true, force: true });
  const sourceConfig = readFileSync(join(source, ".git", "config"), "utf8");
  writeFileSync(join(origin, "config"), sourceConfig.replace("\tbare = false", "\tbare = true").replace(/\tlogallrefupdates = true\r?\n/, ""));
  // Files check out exactly as tests write them, whatever line endings this machine's own Git settings ask for: Git for
  // Windows converts text to CRLF by default. Copies of the clone carry its settings and their linked working copies
  // share them, so Petrina's own Git keeps files as written there too. A test exercising conversion sets its own.
  cpSync(source, clone, { recursive: true });
  const cloneCore = sourceConfig.replace(/(\[core\]\r?\n)/, "$1\tautocrlf = false\n\teol = lf\n");
  const sections = [
    cloneCore.endsWith("\n") ? cloneCore : `${cloneCore}\n`,
    "[user]\n\temail = test@example.com\n\tname = Test\n",
  ];
  if (remote !== "none") {
    sections.push(`[remote "origin"]\n\turl = ${ADDRESS}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
    if (versionFile) {
      sections.push('[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n');
      const remotesOrigin = join(clone, ".git", "refs", "remotes", "origin");
      mkdirSync(remotesOrigin, { recursive: true });
      writeFileSync(join(remotesOrigin, "main"), `${head}\n`);
      writeFileSync(join(remotesOrigin, "HEAD"), "ref: refs/remotes/origin/main\n");
    }
  }
  writeFileSync(join(clone, ".git", "config"), sections.join(""));
  return Object.freeze({ path, origin, clone, head });
}
// Standalone diagnostic scripts import these helpers too. The parallel runner owns cleanup when
// Bun's isolated workers bypass exit hooks; ordinary scripts clean their seeds on exit.
process.on("exit", () => { for (const path of seedFolders) removeDir(path); });
