// A stand-in for `gh`, for tests: pull requests and releases kept in a JSON file.
// bun fake-gh.ts <state.json> <gh arguments…>
// Set "offline": true in the file and every call fails like GitHub being unreachable.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface FakeGitHub {
  offline?: boolean;
  prs: { number: number; url: string; head: string; state: "OPEN" | "MERGED" | "CLOSED" }[];
  releases: { tagName: string; url: string; publishedAt: string; isDraft: boolean }[];
}

export function readGitHub(path: string): FakeGitHub {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as FakeGitHub) : { prs: [], releases: [] };
}

function main(): never {
  const [statePath, ...args] = process.argv.slice(2);
  const state = readGitHub(statePath!);
  const save = () => writeFileSync(statePath!, JSON.stringify(state, null, 2));
  const flag = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const out = (value: unknown): never => {
    process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
    process.exit(0);
  };
  const fail = (message: string): never => {
    process.stderr.write(`${message}\n`);
    process.exit(1);
  };
  const pick = (entry: Record<string, unknown>) => Object.fromEntries((flag("--json") ?? "").split(",").map((field) => [field, entry[field]]));

  if (state.offline) fail("error connecting to api.github.com");
  const [noun, verb, target] = args;
  if (noun === "pr" && verb === "view") {
    const pr = state.prs.find((entry) => entry.head === target || String(entry.number) === target);
    if (!pr) fail(`no pull requests found for branch "${target}"`);
    if (flag("--jq") === ".state") out(pr!.state);
    out(pick(pr!));
  }
  if (noun === "pr" && verb === "create") {
    const head = flag("--head")!;
    const number = state.prs.length + 1;
    const pr = { number, url: `https://github.com/acme/demo/pull/${number}`, head, state: "OPEN" as const };
    state.prs.push(pr);
    save();
    out(pr.url);
  }
  if (noun === "release" && verb === "view") {
    const published = state.releases.filter((entry) => !entry.isDraft).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    const release = target && !target.startsWith("-") ? state.releases.find((entry) => entry.tagName === target) : published[0];
    if (!release) fail("release not found");
    out(pick(release!));
  }
  if (noun === "release" && verb === "list") out(state.releases.map(pick));
  if (noun === "release" && verb === "create") {
    if (state.releases.some((entry) => entry.tagName === target)) fail("a release with the same tag name already exists");
    const release = { tagName: target!, url: `https://github.com/acme/demo/releases/tag/${target}`, publishedAt: new Date().toISOString(), isDraft: false };
    state.releases.push(release);
    save();
    out(release.url);
  }
  return fail(`fake gh does not know: ${args.join(" ")}`);
}

if (import.meta.main) main();
