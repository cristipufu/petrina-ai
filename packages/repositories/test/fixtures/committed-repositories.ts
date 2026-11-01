import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, CLEANUP_MS } from "@petrina/test-support/commands";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";
import { removeFixtureRoot, removeTreeWithRetries } from "@petrina/test-support/fixture-roots";
import { repositorySeed } from "@petrina/test-support/repositories";
import { SLOW } from "@petrina/test-support/slow";

interface InitialReadme {
  readonly contents: string;
  readonly message: string;
  readonly format?: "sha1" | "sha256";
}

/** Exact committed input recipes, copied privately before a native adapter contract mutates them. */
export function committedRepositoryFixtures(root: string) {
  registerFixtureRoot(root);
  let closing = false;
  const owner = new FixtureOperations({ label: `Committed repository contracts at ${root}`,
    stop() { closing = true; }, dispose: () => removeFixtureRoot(root),
    allowanceMs: CLEANUP_MS * SLOW, arm: (expired, ms) => { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); },
  });
  const check = () => { if (closing) throw new Error("Committed repository fixture is closing"); };
  const templates = new Map<string, Promise<string>>();
  const copy = (destination: string, recipe: InitialReadme) => owner.run(async () => {
    check();
    // Reevaluate the seed environment on every acquisition. A changed configuration selects another seed identity.
    const seed = await repositorySeed(undefined, false, recipe.format, "none");
    check();
    const key = JSON.stringify([seed.path, recipe.contents, recipe.message, recipe.format]);
    let prepared = templates.get(key);
    if (!prepared) {
      prepared = Promise.resolve().then(async () => {
        check();
        const path = mkdtempSync(join(root, ".initial-readme-"));
        cpSync(seed.clone, path, { recursive: true });
        // The source recipe is exactly one committed README, with no version manifest or remote.
        for (const name of readdirSync(path)) if (name !== ".git") removeTreeWithRetries(join(path, name));
        writeFileSync(join(path, "README.md"), recipe.contents);
        await git(path, "add", "-A"); check();
        await git(path, "commit", "-q", "--amend", "-m", recipe.message); check();
        return path;
      });
      templates.set(key, prepared);
    }
    const source = await prepared; check();
    if (existsSync(destination) && readdirSync(destination).length) throw new Error(`A prepared repository destination already exists: ${destination}`);
    mkdirSync(destination, { recursive: true });
    cpSync(source, destination, { recursive: true });
    return destination;
  });
  return { run: <T>(body: () => Promise<T>) => owner.run(body), copy, close: () => owner.close() };
}
