// Route the existing GitHub stand-in to independent local repositories.
import { readFileSync } from "node:fs";
import { extractFakeGhRepo, runFakeGitHub } from "./fake-gh.js";
const [file, ...args] = process.argv.slice(2);
const products = JSON.parse(readFileSync(file!, "utf8")) as Record<string, { state: string; remote: string }>;
const repo = extractFakeGhRepo(args);
const target = products[repo ?? ""] ?? Object.values(products)[0]!;
await runFakeGitHub([target.state, target.remote, ...args]).catch((error: unknown) => {
  process.stderr.write(`fake gh could not answer: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
