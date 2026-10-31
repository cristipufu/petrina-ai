import { afterAll, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPTANCE_RESTORED, ACCEPTANCE_UNACCOUNTED } from "@petrina/core";
import type { EngineOptions } from "../../engine.js";
import { Fakes, tempDir, waitFor } from "../../fixtures.js";
import { scriptedContainerControl, scriptedContainerInspection } from "../../fixtures/container-inspection.js";
import { readLooseCommit } from "../../fixtures/shared-preparation.js";
import { executionFor } from "@petrina/orchestrator";
import { Store } from "@petrina/storage/store";
import * as gitSteps from "@petrina/repositories/git";
import { checkpointAcceptance } from "../../../src/checkpoint-acceptance.js";
import { Coordination } from "../../../src/coordination.js";
import type { ExtraValidation } from "@petrina/core";
import { proofRequestFixtures } from "../../fixtures/proof-requests.js";

const { roots, signal, fixture, passes, testerSteps, restoredLine, lockRecords, cleanupHolds, close } = proofRequestFixtures();
afterAll(close);
for (const extra of [false, true]) it.skipIf(extra && process.platform === "win32")(`recovers Tester restoration once after shutdown${extra ? " with late extra-validation settlement" : " without extra validation"}`, async () => {
  const fakeRoot = tempDir("petrina-acceptance-extra-close-"); roots.push(fakeRoot);
  const service = join(fakeRoot, "container-service"); mkdirSync(service);
  const fakes = new Fakes(fakeRoot);
  let activeDataDir = "";
  const settings: EngineOptions = {
    containerTool: [process.execPath, join(import.meta.dir, "../../fake-extra-container.ts"), service],
    containerInspection: scriptedContainerInspection(service),
    containerControl: scriptedContainerControl(service, () => createHash("sha256").update(realpathSync(activeDataDir)).digest("hex")),
    extraCleanupEveryMs: 60_000,
    validationSnapshots: {
      async snapshot(record) {
        const commit = readLooseCommit(join(record.source, ".git"), record.commit);
        if (!commit || commit.tree !== record.tree) throw new Error("The validation copy does not match the saved commit");
        mkdirSync(join(record.snapshot, ".git"), { recursive: true, mode: 0o755 });
      },
    },
  };
  const f = await fixture(false, false, fakes, settings);
  activeDataDir = f.engine.dataDir;
  const patchExtraContainer = (eng: typeof f.engine) => {
    const container = eng.extraValidations["container"];
    container["stopClient"] = async (record: ExtraValidation) => {
      if (record.clientPid) {
        try { process.kill(-record.clientPid, "SIGKILL"); } catch {}
        try { process.kill(record.clientPid, "SIGKILL"); } catch {}
      }
      return true;
    };
  };
  patchExtraContainer(f.engine);
  const released = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let stopping: Promise<void> | undefined, driving: Promise<void> | undefined;
  try {
    const request = await f.request(), worktree = f.scope.work.worktree!;
    writeFileSync(join(worktree, "tester-edit.txt"), "Saved before acceptance\n");
    await gitSteps.commitChanges(worktree, "Save a project file");
    await f.engine.rememberVersion(f.scope);
    f.products[0]!.shipLowRisk = true; f.task.retest = true; f.task.stageIndex = 1;
    fakes.scenario({ reopen: "resume", tester: "work", testerFiles: [{ dir: worktree, file: "tester-edit.txt", text: "Edited before Petrina closes\n" }], testerProofAnswers: passes([request.id]) });
    driving = f.drive();
    await waitFor(() => fakes.marked("tester-worked") && f.scope.work.conversation?.briefed, "the real Tester to be at work", undefined, { during: driving });
    let record: ExtraValidation | undefined;
    if (extra) {
      const reply = await new Coordination(f.engine).call("validation.run", { taskId: f.task.id, requestId: "late-shutdown-extra", name: "Required platform check", reason: "Verify shutdown evidence isolation", image: "local:ready", argv: ["probe", "hold"] });
      expect(reply.outcome).toBe("pending"); record = reply.validation as ExtraValidation;
      // This fixture disables automatic drivers; still use the product's real queue admission.
      f.engine.extraValidations.pump();
      await waitFor(() => existsSync(join(service, "started", record!.id)), "the owned extra workload to start");
      const container = f.engine.extraValidations["container"], cleanup = container.cleanup.bind(container);
      container.cleanup = async owned => { entered.resolve(); await released.promise; return cleanup(owned); };
    }
    f.engine.setPoolPaused(true); stopping = f.stop(f.engine);
    if (extra) await entered.promise;
    await driving;
    const cleanup = f.task.acceptanceCleanupPending!, marker = join(f.engine.dataDir, "acceptance-restorations", `${cleanup}.json`);
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(join(worktree, "tester-edit.txt"), "utf8")).toBe("Saved before acceptance\n");
    const warning = restoredLine("changes to project files", "Product 1", "tester-edit.txt");
    expect(f.task.timeline.filter(line => line.text === warning)).toHaveLength(1);
    released.resolve(); await stopping;
    const saved = new Store(join(f.engine.dataDir, "petrina.db"));
    try {
      const task = saved.load()!.tasks.find(task => task.id === f.task.id)!;
      expect(task.acceptanceCleanupPending).toBe(cleanup); expect(task.acceptanceRun!.restored).toBeUndefined();
      expect(task.timeline.filter(line => line.text === warning)).toHaveLength(0);
      if (record) {
        expect(saved.load()!.extraValidations).toEqual([]);
        const evidence = task.journey!.find(node => node.id === record!.nodeId)!.extraValidations![0]!;
        expect(evidence.state).toBe("finished"); expect(evidence.result).toBe("stopped");
        expect(task.timeline.filter(line => line.text.includes("Extra validation") && line.text.includes("seconds"))).toHaveLength(1);
      }
    } finally { saved.close(); }
    f.engine = f.open(f.engine.dataDir, settings); patchExtraContainer(f.engine); f.engine.schedule = () => {};
    await f.engine.waitUntilReady(); f.engine.setPoolPaused(false); f.task = f.engine.task(f.task.id)!; f.scope = executionFor(f.task);
    expect(f.task.timeline.filter(line => line.text === warning)).toHaveLength(1);
    expect(f.task.acceptanceCleanupPending).toBeUndefined(); expect(existsSync(marker)).toBe(false);
    expect(f.task.acceptanceRun!.restored!.products).toEqual([{ productId: f.task.productId, edits: true, files: ["tester-edit.txt"] }]);
    if (record) {
      const result = f.engine.extraValidations.get(record.requestId)!;
      expect(result.outcome).toBe("completed"); expect((result.validation as ExtraValidation).state).toBe("finished");
      expect(result.validation as ExtraValidation).toEqual(f.task.journey!.find(node => node.id === record!.nodeId)!.extraValidations![0]!);
      expect(f.engine.s.extraValidations).toEqual([]); expect(existsSync(record.snapshot)).toBe(false);
      expect(fs.readdirSync(join(service, "containers"))).toEqual([]);
    }
    fakes.scenario({ reopen: "resume", tester: "work", testerProofAnswers: passes([request.id]) });
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    expect(f.task.timeline.filter(line => line.text === warning)).toHaveLength(1);
    expect(f.task.acceptancePassed).toBe(false); expect(f.task.acceptanceUnverified).toBe(true);
    expect(f.task.proofRequests![0]).toMatchObject({ status: "unverified", proof: { result: "blocked", reason: ACCEPTANCE_RESTORED } });
    expect(f.engine["driver"]["shipsUnasked"](f.task)).toBe(false);
  } finally { released.resolve(); await f.close(); }
});

for (const outcome of ["kept", "clean", "unwritable", "unreadable"] as const) it(`${outcome === "clean" ? "settles" : "keeps unverified"} a run resumed after Petrina closed mid-test when the cleanup's record is ${outcome}`, async () => {
  const fakeRoot = tempDir("petrina-acceptance-quit-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  const f = await fixture(false, false, fakes);
  const reopen = async () => {
    f.engine = f.open(f.engine.dataDir); f.engine.schedule = () => {};
    await f.engine.waitUntilReady(); f.engine.setPoolPaused(false); f.task = f.engine.task(f.task.id)!; f.scope = executionFor(f.task);
  };
  const saved = () => { const store = new Store(join(f.engine.dataDir, "petrina.db")); try { return store.load()!.tasks.find(task => task.id === f.task.id)!; } finally { store.close(); } };
  try {
    const request = await f.request(); const worktree = f.scope.work.worktree!;
    const folder = join(f.engine.dataDir, "acceptance-restorations");
    writeFileSync(join(worktree, "tester-edit.txt"), "Saved before acceptance\n");
    await gitSteps.commitChanges(worktree, "Save a project file");
    f.products[0]!.shipLowRisk = true; f.task.retest = true; f.task.stageIndex = 1;
    fakes.scenario({ reopen: "resume", tester: "work", ...(outcome === "clean" ? {} : { testerFiles: [{ dir: worktree, file: "tester-edit.txt", text: "Edited before Petrina closes\n" }] }), testerProofAnswers: passes([request.id]) });
    const driving = f.drive();
    await waitFor(() => fakes.marked("tester-worked") && f.scope.work.conversation?.briefed, "the Tester to be at work", undefined, { during: driving });
    expect(f.task.acceptanceRun!.restored).toBeUndefined();
    // A file where the record's folder belongs makes the record impossible to write.
    if (outcome === "unwritable") writeFileSync(folder, "Not a folder\n");
    f.engine.setPoolPaused(true); await f.stop(f.engine); await driving;
    expect(readFileSync(join(worktree, "tester-edit.txt"), "utf8")).toBe("Saved before acceptance\n");
    // The last save marked the run with its cleanup's identity before the cleanup could look; only that cleanup's record can clear it.
    const cleanup = saved().acceptanceCleanupPending!, record = join(folder, `${cleanup}.json`);
    expect(cleanup).toMatch(/^[0-9a-f]{24}$/); expect(saved().acceptanceRun!.restored).toBeUndefined();
    expect(existsSync(record)).toBe(outcome !== "unwritable");
    if (outcome === "unwritable") rmSync(folder);
    if (outcome === "unreadable") writeFileSync(record, "{ not a record");
    await reopen();
    const restored = outcome === "kept" ? [{ productId: f.task.productId, edits: true, files: ["tester-edit.txt"] }] : [];
    expect(f.task.acceptanceCleanupPending).toBeUndefined(); expect(saved().acceptanceCleanupPending).toBeUndefined();
    expect(existsSync(record)).toBe(false);
    if (outcome === "clean") expect(f.task.acceptanceRun!.restored).toBeUndefined();
    else { expect(f.task.acceptanceRun!.restored!.products).toEqual(restored); expect(saved().acceptanceRun!.restored!.products).toEqual(restored); }
    expect(f.task.timeline.some(entry => entry.text === restoredLine("changes to project files", "Product 1", "tester-edit.txt"))).toBe(outcome === "kept");
    expect(f.task.timeline.some(entry => entry.text === "This acceptance run cannot verify the product: Petrina closed during it and could not read what its cleanup undid")).toBe(outcome === "unwritable" || outcome === "unreadable");
    // The same conversation reopens and answers with a pass, without editing again.
    fakes.scenario({ reopen: "resume", tester: "work", testerProofAnswers: passes([request.id]) });
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    const proof = f.task.proofRequests![0]!, final = testerSteps(f).at(-1)!;
    expect(fakes.openings("tester")).toHaveLength(1);
    if (outcome === "clean") {
      expect(proof.status).toBe("proved"); expect(f.task.acceptancePassed).toBe(true); expect(final.proofRun!.restored).toBeUndefined();
      return;
    }
    // Without a record nothing shows that Petrina undid anything, and the reason says so.
    const reason = outcome === "kept" ? ACCEPTANCE_RESTORED : ACCEPTANCE_UNACCOUNTED;
    expect(proof.status).toBe("unverified"); expect(proof.proof).toMatchObject({ stepId: final.id, result: "blocked", reason });
    expect(final.proofRun!.restored!.products).toEqual(restored);
    expect(final.reason).toBe(outcome === "kept" ? "Petrina undid changes during acceptance testing" : "Petrina could not confirm what its cleanup undid");
    expect(f.task.timeline.some(entry => entry.text === `Acceptance could not be verified: ${reason}`)).toBe(true);
    expect(checkpointAcceptance(f.task, f.engine.s.roles).evidence).toMatchObject({ nodeId: final.id, checks: [{ result: "blocked", reason }, { result: "blocked", reason }], restored: { reason, products: outcome === "kept" ? [{ productId: f.task.productId, edits: true }] : [] } });
    expect(f.task.acceptancePassed).toBe(false); expect(f.task.acceptanceUnverified).toBe(true);
    expect(f.engine["driver"]["shipsUnasked"](f.task)).toBe(false);
    if (outcome !== "kept") return;
    // A record no marked run names, such as one an earlier start could not remove, changes nothing and goes.
    const lines = f.task.timeline.length;
    f.engine.setPoolPaused(true); await f.stop(f.engine);
    mkdirSync(folder, { recursive: true });
    writeFileSync(record, JSON.stringify({ taskId: f.task.id, cleanup, restored: { at: 1, products: restored }, lines: ["An unrelated record"] }));
    await reopen();
    expect(existsSync(record)).toBe(false); expect(f.task.acceptanceRun).toBeUndefined(); expect(f.task.timeline).toHaveLength(lines);
  } finally { await f.close(); }
});

for (const folderState of ["locked", "writable"] as const) it(`keeps a run unverified after a second close ${folderState === "locked" ? "when only an earlier cleanup's record of it remains" : "whose cleanup's record arrives"}`, async () => {
  const fakeRoot = tempDir("petrina-acceptance-stale-record-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  const f = await fixture(false, false, fakes);
  const reopen = async () => {
    f.engine = f.open(f.engine.dataDir); f.engine.schedule = () => {};
    await f.engine.waitUntilReady(); f.engine.setPoolPaused(false); f.task = f.engine.task(f.task.id)!; f.scope = executionFor(f.task);
  };
  const saved = () => { const store = new Store(join(f.engine.dataDir, "petrina.db")); try { return store.load()!.tasks.find(task => task.id === f.task.id)!; } finally { store.close(); } };
  const folder = join(f.engine.dataDir, "acceptance-restorations");
  let locked: ReturnType<typeof lockRecords> | undefined;
  try {
    const request = await f.request(); const worktree = f.scope.work.worktree!, edited = join(worktree, "tester-edit.txt");
    writeFileSync(edited, "Saved before acceptance\n");
    await gitSteps.commitChanges(worktree, "Save a project file");
    f.products[0]!.shipLowRisk = true; f.task.retest = true; f.task.stageIndex = 1;
    fakes.scenario({ reopen: "resume", tester: "work", testerProofAnswers: passes([request.id]) });
    const driving = f.drive();
    await waitFor(() => fakes.marked("tester-worked") && f.scope.work.conversation?.briefed, "the Tester to be at work", undefined, { during: driving });
    f.engine.setPoolPaused(true); await f.stop(f.engine); await driving;
    // A genuine record that this cleanup undid nothing, for this same task and run.
    const first = saved().acceptanceCleanupPending!, earlier = join(folder, `${first}.json`);
    expect(JSON.parse(readFileSync(earlier, "utf8"))).toEqual({ taskId: f.task.id, cleanup: first, lines: [] });
    if (folderState === "locked") locked = lockRecords(folder, earlier);
    await reopen();
    expect(f.task.acceptanceRun!.restored).toBeUndefined(); expect(existsSync(earlier)).toBe(folderState === "locked");
    expect(locked?.refused ?? []).toEqual(folderState === "locked" ? [`${first}.json`] : []);
    // The same conversation goes on, edits the saved file and is still working when Petrina closes again.
    rmSync(join(fakes.dir, "tester-worked"));
    fakes.scenario({ reopen: "resume", tester: "work", testerFiles: [{ dir: worktree, file: "tester-edit.txt", text: "Edited after the first close\n" }], testerProofAnswers: passes([request.id]) });
    const working = f.run(f.engine, () => f.engine["work"].runDo(f.scope, f.tester, signal()).then(() => undefined, (error: unknown) => error));
    await waitFor(() => fakes.marked("tester-worked") && readFileSync(edited, "utf8") === "Edited after the first close\n", "the resumed Tester to edit", undefined, { during: working });
    f.engine.setPoolPaused(true); await f.stop(f.engine); await working;
    expect(readFileSync(edited, "utf8")).toBe("Saved before acceptance\n");
    const second = saved().acceptanceCleanupPending!;
    expect(second).not.toBe(first); expect(existsSync(join(folder, `${second}.json`))).toBe(folderState === "writable");
    expect(existsSync(earlier)).toBe(folderState === "locked");
    expect(locked?.refused ?? []).toEqual(folderState === "locked" ? [`${first}.json`, `${second}.json.tmp`] : []);
    locked?.restore();
    await reopen();
    expect(existsSync(earlier)).toBe(false); expect(f.task.acceptanceCleanupPending).toBeUndefined();
    const restored = folderState === "writable" ? [{ productId: f.task.productId, edits: true, files: ["tester-edit.txt"] }] : [];
    expect(f.task.acceptanceRun!.restored!.products).toEqual(restored);
    expect(f.task.timeline.some(entry => entry.text === "This acceptance run cannot verify the product: Petrina closed during it and could not read what its cleanup undid")).toBe(folderState === "locked");
    // The same conversation answers with a pass, without editing again.
    fakes.scenario({ reopen: "resume", tester: "work", testerProofAnswers: passes([request.id]) });
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    const proof = f.task.proofRequests![0]!, final = testerSteps(f).at(-1)!;
    expect(fakes.openings("tester")).toHaveLength(1);
    expect(final.proofRun!.restored!.products).toEqual(restored);
    expect(proof.status).toBe("unverified"); expect(proof.proof).toMatchObject({ stepId: final.id, result: "blocked", reason: folderState === "writable" ? ACCEPTANCE_RESTORED : ACCEPTANCE_UNACCOUNTED });
    expect(f.task.acceptancePassed).toBe(false); expect(f.task.acceptanceUnverified).toBe(true);
    expect(f.task.findings).toEqual([]); expect(f.engine["driver"]["shipsUnasked"](f.task)).toBe(false);
  } finally { locked?.restore(); await f.close(); }
});

for (const phase of Object.keys(cleanupHolds) as (keyof typeof cleanupHolds)[]) it(`keeps the resumed run unverified when Petrina closes after the Tester answered, with its cleanup ${phase === "approval-off" ? "starting in a plan without the delivery check" : `held when ${phase}`}`, async () => {
  const fakeRoot = tempDir("petrina-acceptance-cleanup-close-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  const shared = phase === "companion", gated = phase !== "approval-off", committed = phase === "commit" || phase === "companion";
  const f = await fixture(shared, false, fakes);
  const reopen = async () => {
    f.engine = f.open(f.engine.dataDir); f.engine.schedule = () => {};
    await f.engine.waitUntilReady(); f.engine.setPoolPaused(false); f.task = f.engine.task(f.task.id)!; f.scope = executionFor(f.task);
  };
  const saved = () => { const store = new Store(join(f.engine.dataDir, "petrina.db")); try { return store.load()!.tasks.find(task => task.id === f.task.id)!; } finally { store.close(); } };
  const release = Promise.withResolvers<void>();
  let holding = false, spy: { mockRestore(): void } | undefined;
  try {
    const request = gated ? await f.request() : undefined;
    const touched = f.owners[shared ? 1 : 0]!;
    writeFileSync(join(touched.worktree, "tester-edit.txt"), "Saved before acceptance\n");
    await gitSteps.commitChanges(touched.worktree, "Save a project file");
    if (gated) { f.products[0]!.shipLowRisk = true; f.task.retest = true; }
    else { f.task.approveDelivery = false; f.products[0]!.approveDelivery = false; f.task.plan!.stages = f.task.plan!.stages.filter(stage => stage.gate !== "delivery"); }
    f.task.stageIndex = 1;
    const name = cleanupHolds[phase], original = gitSteps[name] as (path: string, ...rest: unknown[]) => Promise<unknown>;
    spy = spyOn(gitSteps, name).mockImplementation((async (path: string, ...rest: unknown[]) => {
      if (!holding && path === touched.worktree && fakes.marked("tester-passed-once") && !f.engine.runs.has(f.task.id)) { holding = true; await release.promise; }
      return original(path, ...rest);
    }) as never);
    fakes.scenario({ reopen: "resume", testerFiles: [{ dir: touched.worktree, file: "tester-edit.txt", text: "Changed during acceptance\n", commit: committed }], ...(request ? { testerProofAnswers: passes([request.id]) } : {}) });
    const running = f.run(f.engine, () => f.engine["work"].runDo(f.scope, f.tester, signal()).then(() => undefined, (error: unknown) => error));
    await waitFor(() => holding, `the cleanup to reach the ${phase} point`, undefined, { during: running });
    const stopping = f.stop(f.engine); release.resolve(); await stopping; await running;
    spy.mockRestore(); spy = undefined;
    expect(readFileSync(join(touched.worktree, "tester-edit.txt"), "utf8")).toBe("Saved before acceptance\n");
    expect(await gitSteps.isClean(touched.worktree)).toBe(true);
    // The last save kept the run marked; a fact noted before the close was saved with it.
    expect(saved().acceptanceCleanupPending).toMatch(/^[0-9a-f]{24}$/);
    expect(saved().acceptanceRun!.restored !== undefined).toBe(["restoring", "commit", "companion"].includes(phase));
    await reopen();
    const restored = [{ productId: touched.productId, ...(committed ? { commits: true } : { edits: true }), files: ["tester-edit.txt"] }];
    expect(f.task.acceptanceCleanupPending).toBeUndefined(); expect(f.task.acceptanceRun!.restored!.products).toEqual(restored);
    expect(f.task.timeline.some(entry => entry.text === restoredLine(committed ? "commits" : "changes to project files", shared ? "Product 2" : "Product 1", "tester-edit.txt"))).toBe(true);
    // The same conversation reopens and answers with a pass, without editing again.
    fakes.scenario({ reopen: "resume", ...(request ? { testerProofAnswers: passes([request.id]) } : {}) });
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    expect(fakes.openings("tester")).toHaveLength(1);
    expect(testerSteps(f).at(-1)!.proofRun!.restored!.products).toEqual(restored);
    expect(f.task.acceptancePassed).toBe(false); expect(f.task.acceptanceUnverified).toBe(true);
    expect(f.task.findings).toEqual([]); expect(f.scope.work.acceptanceReturns).toBeUndefined();
    expect(f.engine["driver"]["shipsUnasked"](f.task)).toBe(false);
    if (request) expect(f.task.proofRequests![0]).toMatchObject({ status: "unverified", proof: { result: "blocked", reason: ACCEPTANCE_RESTORED } });
    else expect(f.task.plan!.stages.some(stage => stage.kind === "gate" && stage.gate === "delivery")).toBe(true);
  } finally { release.resolve(); spy?.mockRestore(); await f.close(); }
});

it("keeps an undone change with its acceptance run through a stand-in and a restart, then settles it unverified once", async () => {
  const fakeRoot = tempDir("petrina-acceptance-continuation-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  const f = await fixture(false, false, fakes);
  try {
    const request = await f.request(); const worktree = f.scope.work.worktree!;
    writeFileSync(join(worktree, "tester-edit.txt"), "Saved before acceptance\n");
    await gitSteps.commitChanges(worktree, "Save a project file");
    f.task.retest = true; f.task.stageIndex = 1;
    // The first Tester edits and runs out of usage; its stand-in edits nothing and works until Petrina restarts.
    fakes.scenario({ tester: "work", limited: [{ model: "opus", role: "tester" }], testerFiles: [{ dir: worktree, file: "tester-edit.txt", text: "Edited before running out\n", model: "opus" }], testerProofAnswers: passes([request.id]) });
    const first = f.run(f.engine, () => f.engine["work"].runDo(f.scope, f.tester, signal()).then(() => undefined, (error: unknown) => error));
    await waitFor(() => fakes.marked("tester-worked"), "the stand-in Tester to be at work", undefined, { during: first });
    const restored = [{ productId: f.task.productId, edits: true, files: ["tester-edit.txt"] }];
    expect(f.task.acceptanceRun!.restored!.products).toEqual(restored);
    expect(testerSteps(f)).toHaveLength(2);
    expect(testerSteps(f).every(step => step.proofRun?.restored?.products.length === 1)).toBe(true);
    expect(readFileSync(join(worktree, "tester-edit.txt"), "utf8")).toBe("Saved before acceptance\n");
    const run = structuredClone(f.task.acceptanceRun);
    f.engine.setPoolPaused(true); await f.stop(f.engine); await first;
    f.engine = f.open(f.engine.dataDir); f.engine.schedule = () => {};
    await f.engine.waitUntilReady(); f.engine.setPoolPaused(false); f.task = f.engine.task(f.task.id)!; f.scope = executionFor(f.task);
    expect(f.task.acceptanceRun).toEqual(run);
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    const saved = f.task.proofRequests![0]!, final = testerSteps(f).at(-1)!;
    expect(saved.status).toBe("unverified"); expect(saved.proof).toMatchObject({ stepId: final.id, versions: run!.versions, result: "blocked", reason: ACCEPTANCE_RESTORED });
    expect(final.profileId).not.toBe("opus-high"); expect(final.proofRun!.restored!.products).toEqual(restored);
    expect(f.task.acceptanceUnverified).toBe(true); expect(f.task.acceptanceRun).toBeUndefined();
    expect(f.task.findings).toEqual([]); expect(f.scope.work.acceptanceReturns).toBeUndefined();
  } finally { await f.close(); }
});
