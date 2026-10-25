import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../engine.js";
import { commandText } from "../../src/checks.js";
import { executionFor } from "@petrina/orchestrator";
import { git, makeProduct, tempDir } from "../fixtures.js";

/** Only review preparation is exercised: no planning, building or reviewer process is needed. */
export async function checkAdmissionFixture(roots: string[], engines: Engine[]) {
  const root = tempDir("petrina-check-admission-"); roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => { throw new Error("Review preparation must not start an agent"); }, terminals: () => [] });
  engines.push(engine);
  engine.schedule = () => engine.checkQueue.pump();
  await engine.waitUntilReady();
  const clone = await makeProduct(root), productId = await engine.addProduct(clone);
  const initial = await git(clone, "rev-parse", "HEAD");
  const log = join(root, "checks.jsonl"), script = join(root, "check.ts");
  writeFileSync(script, `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { git } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/commands"))};
const [log, root, command] = process.argv.slice(2);
const name = readFileSync("task-name", "utf8");
const sha = await git(process.cwd(), "rev-parse", "HEAD");
const tree = await git(process.cwd(), "rev-parse", "HEAD^{tree}");
const fix = existsSync("main-fix.txt");
appendFileSync(log, JSON.stringify({ name, sha, tree, fix, command }) + "\\n");
writeFileSync(root + "/" + name + ".started", "ready");
if (name === "first") while (!existsSync(root + "/release-first")) await Bun.sleep(10);
process.exit(existsSync("needs-main-fix.txt") && !fix ? 1 : 0);`);
  const define = (command: string) => engine.setProductChecks(productId, [{ name: "Tests", command: commandText([process.execPath, script, log, root, command]) }]);
  define("original");
  const add = async (name: string, needsFix = false, conflict = false) => {
    const task = engine.task(engine.addTask({ productId, title: name, delivery: "local", backlog: true }))!;
    task.state = "running"; task.startedAt = 1; task.stageIndex = 1; task.rounds = { review: 1 };
    task.plan = { rationale: "Check review admission", plannerProfileId: "sol-high", stages: [
      { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
      { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 2 },
    ] };
    const scope = executionFor(task), copy = join(root, name), branch = `task-${name}`;
    await git(clone, "worktree", "add", "-b", branch, copy, initial);
    Object.assign(scope.work, { worktree: copy, branch, base: "main", baseSha: initial, report: { title: `Improve ${name}`, summary: `Improve ${name}`, changes: [`Improved ${name}`] } });
    writeFileSync(join(copy, "task-name"), name);
    if (needsFix) writeFileSync(join(copy, "needs-main-fix.txt"), "This task needs the already-landed fix\n");
    if (conflict) writeFileSync(join(copy, "README.md"), "The task rewrites this file\n");
    await git(copy, "add", "."); await git(copy, "commit", "-qm", `Improve ${name}`);
    return { task, scope, copy };
  };
  const review = (entry: Awaited<ReturnType<typeof add>>) => engine["reviews"].runReview(entry.task, entry.task.plan!.stages[1]!, new AbortController().signal);
  const evidence = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { name: string; sha: string; tree: string; fix: boolean; command: string }) : [];
  const land = async (conflict = false, discovery = false) => {
    writeFileSync(join(clone, conflict ? "README.md" : "main-fix.txt"), conflict ? "Main rewrites this file differently\n" : "The previously landed fix\n");
    if (discovery) writeFileSync(join(clone, "package.json"), JSON.stringify({ name: "changed-check-inputs", scripts: { test: "the new required command" } }));
    await git(clone, "add", "."); await git(clone, "commit", "-qm", "Land the current fix");
    return git(clone, "rev-parse", "HEAD");
  };
  const release = () => writeFileSync(join(root, "release-first"), "continue");
  return { root, engine, clone, add, review, evidence, land, release, define };
}
