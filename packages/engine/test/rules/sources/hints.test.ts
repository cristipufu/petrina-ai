import { hintProducts, BUILT_IN_ROLES, createTaskState, DEFAULT_PROFILES, KNOWN_TOOLS, type Product, type Role, type Task } from "@petrina/core";
import { expect, it } from "bun:test";
import { BriefResult, contractFor, PlanResult } from "../../../src/roles.js";
import { checkSourceHints } from "../../../src/source-hints.js";

it("keeps each valid hint by its exact product id and leaves out the rest without failing the result", () => {
  const pointer = { productId: "shop", revision: "a".repeat(40), path: "docs/design.md" };
  for (const none of [undefined, null, []]) expect(checkSourceHints(none, ["shop"])).toEqual({ pointers: [] });
  const site = { ...pointer, productId: "site" };
  const mixed = checkSourceHints([pointer, { ...pointer, recommendation: "Use my preferred design" }, { ...pointer, path: "../other-product" }, { ...pointer, revision: "main" }, { ...pointer, productId: "acme/shop" }, { ...pointer, productId: " shop" }, pointer, site], ["shop", "site"]);
  expect(mixed).toEqual({ pointers: [pointer, site], left: "Left out 5 optional source locations: 2 did not name one of this task's products by its exact id; 3 were not repository locations at a full source version. Kept 2." });
  const many = Array.from({ length: 10 }, (_, index) => ({ ...pointer, path: `file-${index}.md` }));
  expect(checkSourceHints([...many.slice(0, 8), many[0], ...many.slice(8)], ["shop"])).toEqual({ pointers: many.slice(0, 8), left: "Left out 2 optional source locations: 2 went past the limit of eight. Kept 8." });
  // The current version is settled only when hints are passed on: an older copy listed first never displaces it.
  const older = { ...pointer, revision: "b".repeat(40) };
  expect(checkSourceHints([older, pointer, { ...pointer, revision: "A".repeat(40) }, older], ["shop"])).toEqual({ pointers: [older, pointer] });
  expect(checkSourceHints("docs/design.md", ["shop"])).toEqual({ pointers: [], left: "Left out 1 optional source location: 1 was not a repository location at a full source version. Kept none." });
  expect(checkSourceHints([pointer], [])).toEqual({ pointers: [], left: "Left out 1 optional source location: 1 did not name one of this task's products by its exact id. Kept none." });
  // Optional hints never decide whether the rest of a plan or brief is usable; required fields keep their checks.
  expect(BriefResult.safeParse({ summary: "A brief", acceptance: ["Done"], sourcePointers: "docs/design.md" }).success).toBe(true);
  expect(BriefResult.safeParse({ summary: "A brief", acceptance: [], sourcePointers: [pointer] }).success).toBe(false);
  expect(PlanResult.safeParse({ rationale: "Build it", stages: [{ kind: "do", title: "Build", roleId: "builder" }], sourcePointers: [...many, { ...pointer, revision: "main" }] }).success).toBe(true);
  expect(hintProducts({ productId: "shop", repositories: [{ productId: "shop", delivery: "local", completedStages: [] }, { productId: "site", delivery: "local", completedStages: [], removed: true }] })).toEqual(["shop"]);
  expect(hintProducts({ productId: "shop" })).toEqual(["shop"]);
});

it("names the exact registered product ids to built-in, renamed and added design authors and to the planner", () => {
  const product: Product = { id: "petrina-ai", name: "Petrina", repo: "cristipufu/petrina-ai", tone: "blue" };
  const base: Task = createTaskState({ productId: product.id, title: "Carry source hints", delivery: "pull-request" }, [product], { id: "task-hints", timelineId: "hints-created", now: 1_000_000_000, priority: 0 });
  const shared: Task = { ...base, repositories: ["shop", "site", "gone"].map((productId) => ({ productId, delivery: "local", completedStages: [], ...(productId === "gone" ? { removed: true } : {}) })) };
  const job = (role: Role, task: Task) => contractFor(role).instructions({ task, product, role, roles: BUILT_IN_ROLES, profiles: DEFAULT_PROFILES, tools: KNOWN_TOOLS, worktree: "/w", branch: "b", base: "origin/main", defaultBranch: "main", sections: [] });
  const architect = BUILT_IN_ROLES.find((role) => role.id === "architect")!;
  for (const role of [architect, { ...architect, name: "Designer", instructions: "Design the change." }, { ...architect, id: "added-designer", name: "Designer", added: true, instructions: "Design the change." }]) {
    expect(job(role, base)).toContain(`productId: "petrina-ai" (this task's registered product id)`);
    expect(job(role, shared)).toContain(`productId: one of "shop", "site" (this task's registered product ids)`);
    expect(job(role, base)).toContain("never a GitHub repository, folder or product name");
  }
  expect(job(BUILT_IN_ROLES.find((role) => role.id === "planner")!, base)).toContain(`productId: the registered id of a product in worksOn (selected now: "petrina-ai")`);
});
