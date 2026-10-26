import { expect, it } from "vitest";
import { checkSetupOutcome } from "@petrina/core";
import { CheckSetup } from "../../../src/check-setup.js";
import type { CheckSetupExecution } from "../../../src/ports/check-setup.js";
import { browser, compiler, deferred, facts, fixture, reply } from "../../fixtures/check-setup.js";

it("observes the baseline for zero requirements without executing a command or inventing a row", async () => {
  const f = fixture(), attempt = await f.run();
  expect(f.calls).toEqual(["executor", "finish:none"]); expect(attempt.results).toEqual([]);
  expect(checkSetupOutcome(attempt).kind).toBe("verified"); expect(f.identities()).toBe(1);
  expect(f.published[0]!.lifecycle).toBe("running"); expect(f.published[0]!.results).toEqual([]);
  expect(f.published.at(-1)!.lifecycle).toBe("settled");
});

it("awaits each actual requirement effect before the next and keeps earlier progress immutable", async () => {
  const f = fixture([compiler, browser]), entered = deferred<void>(), release = deferred<CheckSetupExecution>();
  f.host.execute = async requirement => { f.calls.push(requirement.id); if (requirement.id === compiler.id) { entered.resolve(); return release.promise; } return reply(requirement); };
  const running = f.run(); await entered.promise;
  expect(f.calls).toEqual(["executor", compiler.id]);
  release.resolve(reply(compiler)); const attempt = await running;
  expect(f.calls).toEqual(["executor", compiler.id, browser.id, "finish:commands"]);
  expect(attempt.results.map(row => row.requirementId)).toEqual([compiler.id, browser.id]);
  expect(f.published[0]!.results).toEqual([]); expect(checkSetupOutcome(attempt).kind).toBe("verified");
});

it("stops at the first nonpass and reports a prerequisite unmet rather than a product failure", async () => {
  const f = fixture([compiler, browser]); f.host.execute = async requirement => { f.calls.push(requirement.id); return reply(requirement, 7); };
  const attempt = await f.run();
  expect(f.calls).toEqual(["executor", compiler.id, "finish:commands"]);
  expect(attempt.results).toHaveLength(1); expect(checkSetupOutcome(attempt)).toEqual({ kind: "unmet", requirementId: compiler.id, code: 7 });
  expect(f.identities()).toBe(0);
});

it("does not execute under missing or malformed baseline facts", async () => {
  for (const observed of [{ kind: "unavailable" as const, message: "The native API was unavailable" }, { kind: "observed" as const, facts: { ...facts, runtime: { name: "bun", version: "" } } }]) {
    const f = fixture([compiler]); f.host.executor = () => observed;
    const attempt = await f.run();
    expect(attempt.results).toEqual([]); expect(f.calls).toEqual(["finish:none"]);
    expect(checkSetupOutcome(attempt).kind).toBe("unavailable"); expect(f.identities()).toBe(0);
  }
});

it.each(["cancelled", "admission-lost", "inputs-changed"] as const)("keeps denied %s admission distinct from an unavailable native command", async reason => {
  const f = fixture([compiler]); f.host.execute = async () => ({ kind: "not-started", reason });
  const attempt = await f.run();
  expect(attempt.lifecycle).toBe("stopped"); expect(attempt.results).toEqual([]); expect(f.calls.at(-1)).toBe("finish:none");
});

it.each([undefined, new Error("The command boundary rejected")])("preserves the actual rejected value and still restores potentially started work (%#)", async failure => {
  const f = fixture([compiler]); f.host.execute = async () => { throw failure; };
  await expect(f.run()).rejects.toBe(failure);
  expect(f.calls.at(-1)).toBe("finish:commands"); expect(f.published.at(-1)!.observationFailure?.kind).toBe("execution");
});

it("preserves ordered primary and cleanup failures instead of hiding either", async () => {
  const f = fixture([compiler]), primary = new Error("execute"), cleanup = new Error("restore");
  f.host.execute = async () => { throw primary; }; f.host.finish = async () => { throw cleanup; };
  await expect(f.run()).rejects.toMatchObject({ errors: [primary, cleanup] });
  expect(f.published.at(-1)!.observationFailure?.kind).toBe("restoration");
});

it("does not bind a native pass after source changes or observed tracked writes", async () => {
  for (const change of ["source", "write"] as const) {
    const f = fixture([compiler]); f.host.finish = async attempt => ({ afterInput: { ...attempt.input, ...(change === "source" ? { tree: "d".repeat(40) } : {}), trackedChanged: false }, restoration: change === "write" ? "restored" : "unchanged" });
    const attempt = await f.run();
    expect(attempt.results[0]!.run.ok).toBe(true); expect(checkSetupOutcome(attempt).kind).toBe(change === "source" ? "outdated" : "incomplete");
    expect(f.identities()).toBe(0);
  }
});

it("records hash failure separately without changing the command's own result", async () => {
  const f = fixture([compiler]); f.host.identity = () => { throw new Error("The hash API was unavailable"); };
  const attempt = await f.run();
  expect(attempt.results[0]!.run.ok).toBe(true); expect(attempt.observationFailure).toEqual({ kind: "identity", message: "The hash API was unavailable" });
  expect(checkSetupOutcome(attempt).kind).toBe("unavailable");
});

it("does no executor or command work after pre-cancellation", async () => {
  const f = fixture([compiler]); f.signal.abort(); const attempt = await f.run();
  expect(f.calls).toEqual(["finish:none"]); expect(attempt.lifecycle).toBe("stopped"); expect(attempt.results).toEqual([]);
});

it("calls every host method on its actual receiver", async () => {
  const f = fixture([compiler]), seen: string[] = [], owner = { marker: "actual-owner", ...f.host };
  owner.executor = function () { seen.push(this.marker); return { kind: "observed", facts }; };
  owner.execute = async function (requirement) { seen.push(this.marker); return reply(requirement); };
  owner.finish = async function (attempt) { seen.push(this.marker); return { afterInput: { ...attempt.input, trackedChanged: false }, restoration: "unchanged" }; };
  await new CheckSetup(owner).observe(f.request, f.signal.signal);
  expect(seen).toEqual([owner.marker, owner.marker, owner.marker]);
});

it.each([false, true])("keeps cancellation during finishing stopped without identity (declared=%s)", async declared => {
  const f = fixture(declared ? [compiler] : []), entered = deferred<void>(), release = deferred<void>();
  f.host.finish = async attempt => { entered.resolve(); await release.promise; return { afterInput: { ...attempt.input, trackedChanged: false }, restoration: "unchanged" }; };
  const running = f.run(); await entered.promise;
  const commands = [...f.calls];
  f.signal.abort(); release.resolve(); const attempt = await running;
  expect(attempt.lifecycle).toBe("stopped"); expect(attempt.identity).toBeUndefined(); expect(f.identities()).toBe(0);
  expect(f.calls).toEqual(commands); expect(attempt.results).toHaveLength(declared ? 1 : 0);
  if (declared) expect(attempt.results[0]!.run.ok).toBe(true);
  expect(checkSetupOutcome(attempt).kind).toBe("stopped");
});

it("discards identity if its callback cancels the live operation", async () => {
  const f = fixture([compiler]), identity = f.host.identity;
  f.host.identity = attempt => { const value = identity(attempt); f.signal.abort(); return value; };
  const attempt = await f.run();
  expect(attempt.lifecycle).toBe("stopped"); expect(attempt.identity).toBeUndefined(); expect(attempt.results[0]!.run.ok).toBe(true);
});

it("preserves a publication failure after execution and still finishes its effectful work", async () => {
  const f = fixture([compiler]), failure = new Error("Could not save setup progress"), changed = f.host.changed;
  let raised = false;
  f.host.changed = attempt => { changed(attempt); if (attempt.results.length && !raised) { raised = true; throw failure; } };
  await expect(f.run()).rejects.toBe(failure);
  expect(f.calls.at(-1)).toBe("finish:commands"); expect(f.published.at(-1)!.results[0]!.run.ok).toBe(true);
});
