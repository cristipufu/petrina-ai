import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, removeDir } from "../support.js";
import { repositoryRecords } from "./shared-records.js";

export function reviewSettlementFixtures() {
const roots: string[] = [];
async function fixture() {
  const { engine, task } = await repositoryRecords("review-settlement", roots, { git: ["first", "second"] });
  const [first, second] = engine.s.products.map((product) => ({ clone: product.path! })) as [{ clone: string }, { clone: string }];
  try {
  writeFileSync(join(second.clone, "SECOND.md"), "Only the second repository has this file.\n");
  await git(second.clone, "add", "SECOND.md");
  await git(second.clone, "commit", "-q", "-m", "Give the second repository distinct review evidence");
  const products = engine.s.products;
  task.repositories = products.map((product) => ({ productId: product.id, source: { product, start: { kind: "default", branch: "main" }, destination: { mode: "local", kind: "branch", repo: product.repo, branch: "main" }, confirmed: true }, worktree: product.path, delivery: "local", completedStages: [], reviewedSha: `earlier-${product.id}`, reviewedTree: `earlier-tree-${product.id}` }));
  task.activeProductId = "first";
  const stage = { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 2 };
  task.plan = { rationale: "Review both", plannerProfileId: "sol-high", stages: [stage, { id: "delivery", title: "Delivery", kind: "gate", roleId: "release-manager", profileIds: [], gate: "delivery" }] };
  task.stageIndex = 0;
  task.state = "running";
  task.hunt = { stageId: stage.id, round: 1, reported: {}, findings: 0 };
  return { first, second, engine, task, stage };
  } catch (error) { await engine.shutdown(); throw error; }
}
async function close() { return roots.forEach(removeDir); }
return { fixture, close };
}
