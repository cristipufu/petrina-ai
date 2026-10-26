import { expect, it } from "vitest";
import type { WorkChoice } from "@petrina/core";
import { waitDuring } from "../../fixtures/clock.js";
import { sourceChoice, sourceFixture, sourceTask } from "../../fixtures/sources.js";

const API = "acme/api", folder = "/confirmed/api";

function additionFixture() {
  const f = sourceFixture(), task = sourceTask();
  f.products.splice(1); // The API exists remotely but has not been registered by the coordinator.
  f.scripts.repository = async repo => ({ repo, defaultBranch: "main" });
  f.scripts.validBranch = async () => true;
  f.scripts.requireBranch = async (_repo, branch) => { if (branch === "missing-branch") throw new Error("The branch is unavailable. Correct the choice."); };
  f.scripts.pullRequest = async () => { throw new Error("PR #999 is unavailable"); };
  f.scripts.isAbsoluteFolder = path => path === folder;
  f.scripts.folderPath = path => path;
  f.scripts.folderOccupied = async () => false;
  const api: WorkChoice = { productId: API, repo: API, startFrom: { kind: "default" }, delivery: "pull-request" };
  const choices = [sourceChoice(), api];
  return { ...f, task, api, choices };
}

for (const invalid of ["branch", "pull-request", "release"] as const)
  it(`requires a confirmed folder after correcting a proposed repository's invalid ${invalid} choice`, async () => {
    const f = additionFixture(), { task } = f;
    await f.selections.propose(task, [sourceChoice(), { ...f.api,
      startFrom: invalid === "pull-request" ? { kind: "pull-request", value: "999" } : { kind: "branch", name: "missing-branch" },
      delivery: invalid === "release" ? "release" : "pull-request",
    }], true);
    expect(task.error).toBeUndefined(); expect(task.workRows![1]!.error).toBeTruthy();
    expect(task.workRows![1]!.addition).toBeUndefined();
    await f.selections.propose(task, f.choices, true);
    const corrected = task.workRows![1]!;
    expect(corrected.error).toContain("Needs adding"); expect(corrected.addition).toBeUndefined();
    expect(() => f.selections.confirm(task)).toThrow(); expect(task.repositories).toBeUndefined();
    // A saved placeholder is supplied input; it is never treated as coordinator approval.
    expect(() => f.selections.confirm(task)).toThrow();
    delete corrected.error;
    corrected.addition = { name: "Shop API", path: "", productId: corrected.source!.product.id };
    corrected.source!.product.path = "";
    expect(() => f.selections.confirm(task)).toThrow();
    await f.selections.configureAddition(task, API, "Shop API", folder);
    expect(corrected.addition).toEqual({ name: "Shop API", path: folder, productId: corrected.source!.product.id });
    expect(corrected.error).toBeUndefined(); expect(task.workError).toBeUndefined();
    expect(f.calls.filter(call => call.startsWith("occupied:"))).toEqual([`occupied:${folder}`]);
    f.selections.confirm(task);
    expect(task.repositories![1]!.source?.confirmed).toBe(true);
    expect(task.repositories![1]!.source?.product.path).toBe(folder);
    // The paired shared-additions and interrupted-clone native controls prove absent folders before
    // approval, actual cloning/branch selection/publication, and durable recovery. No such effects exist here.
  });

for (const error of [new Error("Cannot inspect the folder"), undefined])
  it(`preserves ${error === undefined ? "undefined" : "Error"} folder-observation failure before recording an addition`, async () => {
    const f = additionFixture(); await f.selections.propose(f.task, f.choices, true);
    const before = structuredClone(f.task), checkpoints = f.checkpoints.length;
    f.scripts.folderOccupied = async () => { throw error; };
    const result = await f.selections.configureAddition(f.task, API, "Shop API", folder).then(() => ({ failed: false }), error => ({ failed: true, error }));
    expect(result).toEqual({ failed: true, error });
    expect("error" in result && result.error).toBe(error); expect(f.task).toEqual(before);
    expect(f.checkpoints).toHaveLength(checkpoints);
    expect(f.calls.some(call => call.startsWith("id:"))).toBe(false);
  });

it("leaves an occupied folder and its unconfirmed row untouched", async () => {
  const f = additionFixture(); await f.selections.propose(f.task, f.choices, true);
  f.scripts.folderOccupied = async () => true;
  const before = structuredClone(f.task);
  await expect(f.selections.configureAddition(f.task, API, "Shop API", folder)).rejects.toThrow("already exists");
  expect(f.task).toEqual(before); expect(f.calls.some(call => call.startsWith("id:"))).toBe(false);
});

for (const error of [new Error("The branch is not on GitHub"), undefined])
  it(`records revalidation ${error === undefined ? "undefined" : "Error"} without hiding the confirmed folder`, async () => {
    const f = additionFixture(); await f.selections.propose(f.task, f.choices, true);
    f.effects.resolve = async () => { throw error; };
    await f.selections.configureAddition(f.task, API, "Shop API", folder);
    const row = f.task.workRows![1]!;
    expect(row.error).toBe(error instanceof Error ? error.message : "undefined");
    expect(row.addition?.path).toBe(folder); expect(f.task.workError).toBe("Some product choices need your attention.");
    expect(f.checkpoints.at(-1)!.workRows![1]!.error).toBe(row.error);
    expect(() => f.selections.confirm(f.task)).toThrow();
  });

it("keeps an already-created saved folder without inspecting or allocating it again", async () => {
  const f = additionFixture(); await f.selections.propose(f.task, f.choices, true);
  await f.selections.configureAddition(f.task, API, "Shop API", folder);
  f.task.workRows![1]!.addition!.created = true;
  const before = structuredClone(f.task), calls = f.calls.length;
  await f.selections.configureAddition(f.task, API, "Shop API", folder);
  expect(f.task).toEqual(before); expect(f.calls.slice(calls)).toEqual([`folder:${folder}`, `path:${folder}`]);
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}

it("addition ownership: keeps the later folder when an older inspection completes last", async () => {
  const f = additionFixture(); await f.selections.propose(f.task, f.choices, true);
  const held = deferred<boolean>();
  f.scripts.isAbsoluteFolder = () => true;
  f.scripts.folderOccupied = path => path === "/earlier/api" ? held.promise : Promise.resolve(false);
  const earlier = f.selections.configureAddition(f.task, API, "Earlier API", "/earlier/api");
  try {
    await f.selections.configureAddition(f.task, API, "Latest API", folder);
    const latest = structuredClone(f.task), checkpoints = f.checkpoints.length;
    held.resolve(false); await earlier;
    expect(f.task).toEqual(latest); expect(f.checkpoints).toHaveLength(checkpoints);
  } finally { held.resolve(false); await earlier; }
});

it("addition ownership: ignores a folder result after a new proposal replaces the rows", async () => {
  const f = additionFixture(); await f.selections.propose(f.task, f.choices, true);
  const held = deferred<boolean>(); f.scripts.folderOccupied = () => held.promise;
  const earlier = f.selections.configureAddition(f.task, API, "Retired API", folder);
  try {
    await f.selections.propose(f.task, f.choices, true);
    const current = structuredClone(f.task), checkpoints = f.checkpoints.length;
    held.resolve(false); await earlier;
    expect(f.task).toEqual(current); expect(f.checkpoints).toHaveLength(checkpoints);
  } finally { held.resolve(false); await earlier; }
});

for (const outcome of ["fulfilled", "Error", "undefined"] as const)
  it(`addition ownership: ignores a superseded revalidation ${outcome}`, async () => {
    const f = additionFixture(); await f.selections.propose(f.task, f.choices, true);
    f.scripts.isAbsoluteFolder = () => true;
    const held = deferred<void>(), resolve = f.effects.resolve;
    let entered = false;
    let first = true;
    f.effects.resolve = async (...args) => {
      const result = await resolve(...args);
      if (!first) return result;
      first = false; entered = true; await held.promise;
      if (outcome !== "fulfilled") throw outcome === "Error" ? new Error("Retired revalidation") : undefined;
      return result;
    };
    const earlier = f.selections.configureAddition(f.task, API, "Earlier API", "/earlier/api");
    try {
      await waitDuring(() => entered, earlier, "the first addition revalidation to enter its held response");
      await f.selections.configureAddition(f.task, API, "Latest API", folder);
      const latest = structuredClone(f.task), checkpoints = f.checkpoints.length;
      held.resolve(); await earlier;
      expect(f.task).toEqual(latest); expect(f.checkpoints).toHaveLength(checkpoints);
    } finally { held.resolve(); await earlier; }
  });

it("addition ownership: a created same-folder instruction supersedes an older pending choice", async () => {
  const f = additionFixture(); await f.selections.propose(f.task, f.choices, true);
  await f.selections.configureAddition(f.task, API, "Saved API", folder);
  f.task.workRows![1]!.addition!.created = true;
  const saved = structuredClone(f.task), held = deferred<boolean>();
  f.scripts.isAbsoluteFolder = () => true;
  f.scripts.folderOccupied = () => held.promise;
  const earlier = f.selections.configureAddition(f.task, API, "Earlier API", "/earlier/api");
  try {
    await f.selections.configureAddition(f.task, API, "Saved API", folder);
    const checkpoints = f.checkpoints.length;
    held.resolve(false); await earlier;
    expect(f.task).toEqual(saved); expect(f.checkpoints).toHaveLength(checkpoints);
  } finally { held.resolve(false); await earlier; }
});

it("addition ownership: independent rows finish without waiting for one another", async () => {
  const f = additionFixture(), other = "acme/worker";
  await f.selections.propose(f.task, [...f.choices, { ...f.api, productId: other, repo: other }], true);
  const held = deferred<boolean>();
  f.scripts.isAbsoluteFolder = () => true;
  f.scripts.folderOccupied = path => path === folder ? held.promise : Promise.resolve(false);
  const earlier = f.selections.configureAddition(f.task, API, "API", folder);
  try {
    await f.selections.configureAddition(f.task, other, "Worker", "/confirmed/worker");
    expect(f.task.workRows![2]!.addition?.path).toBe("/confirmed/worker");
    expect(f.task.workRows![1]!.addition).toBeUndefined();
    held.resolve(false); await earlier;
    expect(f.task.workRows!.slice(1).map(row => row.addition?.name)).toEqual(["API", "Worker"]);
    expect(f.task.workError).toBeUndefined();
  } finally { held.resolve(false); await earlier; }
});


for (const error of [new Error("Retired folder inspection failed"), undefined])
  it(`addition ownership: preserves a superseded raw ${error === undefined ? "undefined" : "Error"} inspection rejection`, async () => {
    const f = additionFixture(); await f.selections.propose(f.task, f.choices, true);
    const held = deferred<boolean>(); f.scripts.isAbsoluteFolder = () => true;
    f.scripts.folderOccupied = path => path === "/earlier/api" ? held.promise : Promise.resolve(false);
    const earlier = f.selections.configureAddition(f.task, API, "Earlier API", "/earlier/api")
      .then(() => ({ failed: false }), error => ({ failed: true, error }));
    try {
      await f.selections.configureAddition(f.task, API, "Latest API", folder);
      const latest = structuredClone(f.task), checkpoints = f.checkpoints.length;
      held.reject(error);
      const result = await earlier;
      expect(result).toEqual({ failed: true, error }); expect("error" in result && result.error).toBe(error);
      expect(f.task).toEqual(latest); expect(f.checkpoints).toHaveLength(checkpoints);
    } finally { held.reject(error); await earlier; }
  });
