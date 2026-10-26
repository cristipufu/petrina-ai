import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../support.js";
import { withRepositoryRecords, type OwnedRepositoryRecords } from "./shared-records.js";

type ReviewSettlement = OwnedRepositoryRecords & {
  first: { clone: string }; second: { clone: string };
  stage: { id: string; title: string; kind: "review-chain"; roleId: string; profileIds: string[]; maxRounds: number };
};

/** Distinct real repositories and complete review work share the canonical root/generation owners. */
export async function withReviewSettlement<T>(body: (fixture: ReviewSettlement) => Promise<T>): Promise<T> {
  return withRepositoryRecords("review-settlement", { git: ["first", "second"] }, async fixture => {
    const { engine, task } = fixture;
    const [first, second] = engine.s.products.map((product) => ({ clone: product.path! })) as [{ clone: string }, { clone: string }];
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
    return body({ ...fixture, first, second, stage });
  });
}
