import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { afterAll as closeOwnedCases } from "bun:test";
import { ENGINE_TEST_ROOT } from "../../fixtures/runtime-paths.js";
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { draftOf, journeyProblems, ROLE_STARTS, slotUses, takeOverBlock } from "@petrina/core";
import { localFixtureSource, screenFixturePlan } from "../../fixtures/prepared-runtime.js";
import { scriptedToolProbe } from "../../scripted-probes.js";
import { type Engine, type EngineOptions } from "../../engine.js";
import type { Learnings } from "../../../src/learnings.js";
import type { Scenario } from "../../fake-agent.js";
import { Fakes, git, makeProduct, waitFor } from "../../fixtures.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());

// Screen waits inside a live parallel review, and the working copies they keep.


async function fixture(owner: EngineCaseOwner, role: "code reviewer" | "verifier", extra: Scenario = {}, options: EngineOptions = {}) {
  const root = mkdtempSync(join(owner.root, "petrina-screen-review-"));

  const fakes = new Fakes(join(root, "fake"));
  const scenario: Scenario = { planner: "parallel", builder: "plain", reviewer: role === "verifier" ? "important" : undefined, verifier: "not-a-bug", screenRoles: [role], screenRoleHold: true, reopen: "resume", ...extra };
  fakes.scenario(scenario);
  const repo = await makeProduct(root);
  await git(repo, "config", "branch.autoSetupMerge", "false");
  const data = join(root, "data");
  const settings: EngineOptions = { toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" }, antigravity: { status: "logged-out", detail: "The explicit screen fixture has no Antigravity login" }, gh: { status: "not-installed" }, git: { status: "ready" }, node: { status: "ready" } }), agentCommand: profile => [process.execPath, join(ENGINE_TEST_ROOT, "fake-agent.ts"), fakes.dir, ...(profile.toolId === "antigravity" ? ["--logged-out"] : [])], ...options };
  const joinCopies = async (current: Engine) => {
    await Promise.all([...current.settling.values(), ...current.copyCleanups.values()]);
  };
  const own = (current: Engine) => { owner.afterBody(() => joinCopies(current)); return current; };
  let engine = own(owner.open(data, settings));
  try {
    engine.setPoolPaused(true);
    await engine.checkTools();
    const productId = await engine.addProduct(repo);
    engine.setProductDelivery(productId, "pull-request", true);
    const id = engine.addTask({ productId, title: "Check the Mac window", backlog: true });
    const prepared = engine.task(id)!;
    await localFixtureSource(engine, prepared);
    prepared.startedAt = Date.now(); prepared.state = "waiting"; prepared.stageIndex = 1;
    prepared.plan = { rationale: "Only the live parallel review and its owned copies are under test", plannerProfileId: "sol-high", stages: screenFixturePlan(["opus-high", "sol-high"]) };
    // The prepared review has no automated commands to discover; this is fixture data, not an edit command.
    const product = engine.s.products.find(product => product.id === productId)!;
    product.checks = []; product.checksBy = "coordinator";
    await engine["driver"]["prepare"]({ task: prepared, work: prepared.repository! }, new AbortController().signal);
    writeFileSync(join(prepared.repository!.worktree!, "greeting.txt"), "The completed greeting\n");
    await git(prepared.repository!.worktree!, "add", "."); await git(prepared.repository!.worktree!, "commit", "-qm", "Prepare the reviewed change");
    prepared.repository!.report = { summary: "The greeting is ready for independent review", changes: ["A greeting was added"] };
    prepared.repository!.builderSession = { stageId: "build", profileId: "sol-xhigh", toolId: "codex", model: "gpt-6.1-sol", sessionId: "completed-fixture-build" };
    const task = () => engine.getState().tasks.find((entry) => entry.id === id)!;
    const background = (session: string) => writeFileSync(join(fakes.dir, `release-${session}`), "go");
    const release = (session: string) => writeFileSync(join(fakes.dir, `screen-release-${session}`), "go");
    const waiting = () => task().state === "waiting" && task().screen && !task().screen!.granted;
    const onScreen = () => readdirSync(fakes.dir).filter((name) => name.startsWith("on-screen-")).map((name) => name.slice("on-screen-".length));
    return {
      root, data, repo, fakes, scenario, id, productId, task, background, release, waiting, onScreen,
      get engine() { return engine; },
      group: () => waitFor(() => {
        for (const entry of fakes.received()) if (entry.role !== role) background(entry.session);
        return fakes.received(role).length >= 2 && fakes.received(role);
      }, `the ${role} group to start`, 90_000),
      finish: () => waitFor(() => {
        for (const session of onScreen()) release(session);
        if (task().state === "failed") throw new Error(task().error);
        return engine.getState().inbox.some((item) => item.taskId === id && item.kind === "delivery");
      }, "the delivery check", 90_000),
      restart: async () => { await owner.stop(engine); await joinCopies(engine); engine = own(owner.open(data, settings)); },
      close: async () => { await owner.stop(engine); await Promise.all(engine.settling.values()); await Promise.all(engine.copyCleanups.values()); },
    };
  } catch (error) { await owner.stop(engine); throw error; }
}

it.each(["resume", undefined] as const)("keeps an added reviewer's own role and copy across a screen wait, edits and restart (reopen: %s)", async (reopen) => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner, "code reviewer", { planner: "mixed-review", screenRoles: ["security specialist"], reopen });
    try {
      const security = f.engine.addRole(ROLE_STARTS.find((entry) => entry.id === "security")!.draft);
      const role = f.engine.getState().roles.find((entry) => entry.id === security)!;
      f.engine.task(f.id)!.plan!.stages[1]!.roleIds = ["code-reviewer", security];
      f.engine.setPoolPaused(false);
      await waitFor(() => f.waiting() && !f.engine.drivers.has(f.id), "the added reviewer to wait for the screen", 90_000);
      const request = f.task().hunt!.screenTurns![f.task().screen!.member!]!;
      const session = request.conversation.sessionId;
      const copy = request.copy;
      expect(f.task().screen?.roleId).toBe(security);
      expect(request.conversation.role?.instructions).toBe(role.instructions);
      expect(f.task().hunt?.roles?.["reviewer:1"]?.id).toBe(security);
      f.engine.saveRole(security, { ...draftOf(role), instructions: "Use this wording only in a later step." });
      await f.restart();
      f.engine.allowScreen(f.id);
      await waitFor(() => f.onScreen().length === 1, "the added reviewer to continue on the screen");
      expect(f.task().agent?.roleId).toBe(security);
      expect(f.task().conversation?.role?.instructions).toBe(role.instructions);
      expect(f.task().hunt?.screenTurns?.[f.task().screen!.member!]?.copy).toBe(copy);
      if (reopen) expect(f.onScreen()).toEqual([session]);
      else {
        const opening = f.fakes.openings("security specialist").at(-1)!;
        expect(opening).toContain(role.instructions);
        expect(opening).not.toContain("Use this wording only in a later step.");
      }
      await f.finish();
      const verdicts = f.engine.tracking.log.moments({ taskId: f.id, kinds: ["verdict"] });
      expect(verdicts.some((entry) => entry.roleId === security)).toBe(true);
      expect(f.task().findings.some((finding) => finding.roleId === security)).toBe(true);
      expect(journeyProblems(f.task())).toEqual([]);
      expect(existsSync(copy)).toBe(false);
    } finally { await f.close(); }

  });
});

for (const role of ["code reviewer", "verifier"] as const) {
  describe(`${role} screen requests beside a working peer`, () => {
    it("restarts unfinished background peers with fresh copies, keeping only the saved screen conversation", async () => {
      return cases.use("petrina-engine-case-", async owner => {
        const f = await fixture(owner, role, { controlled: true, screenModels: ["gpt-6.1-sol"] });
        try {
          f.engine.setPoolPaused(false);
          await f.group();
          const requester = await waitFor(() => f.fakes.received(role).find((entry) => JSON.parse(readFileSync(join(f.fakes.dir, "conversations", `${entry.session}.json`), "utf8")).model === "gpt-6.1-sol"), "the screen requester's turn to start", 90_000);
          const group = f.fakes.received(role);
          f.background(requester.session);
          await waitFor(() => f.waiting() && f.task().holdsSlot, "the screen request beside its active peer");
          const copy = Object.values(f.task().hunt!.screenTurns!)[0]!.copy;
          const peers = readdirSync(dirname(copy)).filter((name) => name !== basename(copy)).map((name) => join(dirname(copy), name));
          const registeredPeers = peers.map((peer) => realpathSync(peer));
          expect(peers.length).toBeGreaterThan(0);
          const stopped = f.engine;
          await owner.stop(stopped);
          await stopped.settling.get(f.id);
          expect(existsSync(copy)).toBe(true);
          expect(peers.every((peer) => !existsSync(peer))).toBe(true);
          const registered = await git(f.repo, "worktree", "list", "--porcelain");
          for (const peer of registeredPeers) expect(registered).not.toContain(peer);
          await f.restart();
          f.engine.allowScreen(f.id);
          await waitFor(() => f.onScreen().includes(requester.session), "the saved reviewer to resume");
          f.fakes.scenario({ ...f.scenario, controlled: false, screenRoleHold: false });
          f.release(requester.session);
          await f.finish();
          expect(f.fakes.received(role).filter((entry) => entry.session === requester.session)).toHaveLength(2);
          expect(f.fakes.received(role).some((entry) => !group.some((old) => old.session === entry.session))).toBe(true);
        } finally { await f.close(); }

      });
    });

    it("shows the quiet request at once and reopens it before its peer finishes", async () => {
      return cases.use("petrina-engine-case-", async owner => {
        const f = await fixture(owner, role, { controlled: true });
        try {
          await owner.run(f.engine, async () => {
            f.engine.setPoolPaused(false);
            const group = await f.group();
            const session = group[0]!.session;
            const peer = group[1]!.session;
            const seats = slotUses(f.engine.getState()).filter((entry) => entry.taskId === f.id).length;
            f.background(session);
            await waitFor(f.waiting, "the screen request while the peer is working");
            expect(f.engine.getState().inbox.filter((item) => item.taskId === f.id)).toEqual([expect.objectContaining({ kind: "screen", blocking: false })]);
            expect(f.task().statusLine).toStartWith("Needs the screen for:");
            expect(slotUses(f.engine.getState()).filter((entry) => entry.taskId === f.id)).toHaveLength(seats - 1);
            expect(f.fakes.received(role).filter((entry) => entry.session === peer)).toHaveLength(1);

            f.engine.allowScreen(f.id);
            await waitFor(() => f.onScreen().includes(session), "the saved conversation to use the screen beside its working peer");
            expect(f.task().screen?.granted).toBe(true);
            expect(f.engine.getState().inbox.some((item) => item.kind === "screen")).toBe(false);
            expect(f.fakes.received(role).filter((entry) => entry.session === session)).toHaveLength(2);
            expect(f.fakes.opens().filter((entry) => entry.session === session).map((entry) => entry.how)).toEqual(["new", "resume"]);
            const resumed = f.fakes.received(role).findLast((entry) => entry.session === session)!.text;
            expect(resumed).toContain("You may now use the screen for:");
            expect(resumed).not.toContain("Keep what you already know from the previous round");
            const turns = f.engine.tracking.log.turns({ taskId: f.id }).filter(turn => turn.sessionId === session);
            expect(turns).toHaveLength(2);
            expect(new Set(turns.map(turn => turn.agentRunId)).size).toBe(1);
            expect(new Set(turns.map(turn => turn.agentSeat)).size).toBe(1);
            // Its peer has not even finished its first turn.
            expect(f.fakes.received(role).filter((entry) => entry.session === peer)).toHaveLength(1);
            expect(slotUses(f.engine.getState()).filter((entry) => entry.taskId === f.id)).toHaveLength(seats);

          });
        } finally { await f.close(); }

      });
    });

    it("keeps the last reserved slot during ordinary group cleanup", async () => {
      return cases.use("petrina-engine-case-", async owner => {
        const f = await fixture(owner, role, { screenRoles: [] });
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let cleaning = false;
        const original = f.engine.undoReadOnly.bind(f.engine);
        f.engine.undoReadOnly = async (task, roleId) => {
          if (roleId === role.replace(" ", "-") && !cleaning) { cleaning = true; await held; }
          return original(task, roleId);
        };
        try {
          await owner.run(f.engine, async () => {
            f.engine.setPoolLimit(1);
            f.engine.setPoolPaused(false);
            await waitFor(() => cleaning, "the group to reach cleanup", 90_000);
            expect(f.task().holdsSlot).toBe(true);
            expect(slotUses(f.engine.getState())).toHaveLength(1);
            const queued = f.engine.addTask({ productId: f.productId, title: "Another queued task" });
            expect(f.engine.getState().tasks.find((task) => task.id === queued)!.state).toBe("queued");
            release();
            await f.finish();

          });
        } finally { release(); await f.close(); }

      });
    });

    it("takes over and hands back in the saved member's own copy, keeping the edits in the task", async () => {
      return cases.use("petrina-engine-case-", async owner => {
        const f = await fixture(owner, role, {}, { toolPath: () => process.execPath });
        try {
          f.engine.setPoolPaused(false);
          await waitFor(() => f.waiting() && Object.keys(f.task().hunt?.screenTurns ?? {}).length >= 2 && !f.engine.drivers.has(f.id), "the group to wait for the screen", 90_000);
          const session = f.task().conversation!.sessionId;
          const copy = f.task().hunt!.screenTurns![f.task().screen!.member!]!.copy;
          f.engine.allowScreen(f.id);
          await waitFor(() => f.onScreen().includes(session), "the saved member on screen");
          expect(takeOverBlock(f.task(), f.engine.getState())).toBeUndefined();
          await f.engine.takeOver(f.id, "copy");
          const dir = join(f.data, "takeover", f.id);
          const launcher = readdirSync(dir).find((name) => name.startsWith("open."))!;
          expect(readFileSync(join(dir, launcher), "utf8")).toContain(copy);
          expect(f.task().driving?.head).toBe(await git(copy, "rev-parse", "HEAD"));
          expect(existsSync(copy)).toBe(true);
          writeFileSync(join(copy, "committed-by-hand.txt"), "Committed by the coordinator\n");
          await git(copy, "add", ".");
          await git(copy, "commit", "-qm", "A change made by hand");
          writeFileSync(join(copy, "unsaved-by-hand.txt"), "Also keep this\n");
          const preview = await f.engine.handBackPreview(f.id);
          expect(preview).toMatchObject({ files: 2, commits: 1, unsaved: true });
          expect(preview.problem).toBeUndefined();
          expect(existsSync(join(f.task().worktree!, "committed-by-hand.txt"))).toBe(false);
          await f.restart();
          await f.engine.reopenTerminal(f.id, "copy");
          expect(readFileSync(join(dir, launcher), "utf8")).toContain(copy);
          f.release(session);
          f.fakes.scenario({ ...f.scenario, screenRoleHold: false });
          f.engine.setScreenUse("on");
          await f.engine.handBack(f.id, "Keep the window change", true);
          await f.finish();
          expect(readFileSync(join(f.task().worktree!, "committed-by-hand.txt"), "utf8")).toContain("Committed by the coordinator");
          expect(readFileSync(join(f.task().worktree!, "unsaved-by-hand.txt"), "utf8")).toContain("Also keep this");
          expect(f.fakes.received(role).filter((entry) => entry.session === session).some((entry) => entry.text.includes("Keep the window change"))).toBe(true);
          expect(existsSync(copy)).toBe(false);
        } finally { await f.close(); }

      });
    });
  });
}

it.each([false, true])("gives an earlier waiting peer the screen before a later task while saving learnings (live grant: %s)", async (live) => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner, "code reviewer", { learnings: true });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let saving = false;
    // Hold this instance's real result processing across I/O, without slowing any other test or engine.
    const lessons = (f.engine as unknown as { learnings: Learnings }).learnings;
    const note = lessons.note.bind(lessons);
    lessons.note = async (task, words, roleId, profileId) => {
      if (task.task.id === f.id && roleId === "code-reviewer" && !saving) { saving = true; await held; }
      return note(task, words, roleId, profileId);
    };
    try {
      await owner.run(f.engine, async () => {
        if (live) f.engine.setScreenUse("on");
        f.engine.setPoolPaused(false);
        await waitFor(() => Object.keys(f.task().hunt?.screenTurns ?? {}).length === 2, "both earlier reviewers to ask", 90_000);
        const first = f.task().conversation!.sessionId;
        const second = Object.values(f.task().hunt!.screenTurns!).find((entry) => entry.conversation.sessionId !== first)!;
        if (!live) f.engine.setScreenUse("on");
        await waitFor(() => f.onScreen().includes(first), "the first reviewer to get the screen");
        const later = f.engine.addTask({ productId: f.productId, title: "A later screen request" });
        await waitFor(() => f.engine.getState().tasks.find((task) => task.id === later)?.screen !== undefined, "the later task to ask", 90_000);
        expect(second.at).toBeLessThan(f.engine.getState().tasks.find((task) => task.id === later)!.screen!.at);
        f.release(first);
        await waitFor(() => saving, "the first review's learnings to be saved");
        f.engine.setScreenUse("on");
        expect(f.engine.getState().tasks.filter((task) => task.screen?.granted).map((task) => task.id)).toEqual([f.id]);
        release();
        const next = await waitFor(() => f.onScreen().find((session) => session !== first), "the next reviewer to get the screen");
        expect(next).toBe(second.conversation.sessionId);

      });
    } finally { release(); await f.close(); }

  });
});

it("fails and returns the screen and copies when its reviewer crashes beside a peer's unanswered question", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner, "code reviewer", { controlled: true, reviewer: "question", screenModels: ["gpt-6.1-sol"] });
    try {
      f.engine.setPoolPaused(false);
      const group = await f.group();
      const question = group.find((entry) => JSON.parse(readFileSync(join(f.fakes.dir, "conversations", `${entry.session}.json`), "utf8")).model === "opus")!;
      const screen = group.find((entry) => entry !== question)!;
      f.background(question.session);
      await waitFor(() => f.engine.getState().inbox.some((item) => item.taskId === f.id && item.kind === "question"), "the peer's unanswered question");
      f.background(screen.session);
      await waitFor(() => f.task().screen && !f.task().screen!.granted, "the other reviewer's screen request");
      f.engine.allowScreen(f.id);
      await waitFor(() => f.onScreen().includes(screen.session), "the saved reviewer to use the screen");
      const copy = f.task().hunt!.screenTurns![f.task().screen!.member!]!.copy;
      const copies = readdirSync(dirname(copy)).map((name) => join(dirname(copy), name));
      const registered = copies.map((path) => realpathSync(path));
      f.engine.runs.get(f.id)!.close();
      await waitFor(() => f.task().state === "failed", "the crashed step to fail without answering its stopped peer");
      await f.engine.copyCleanups.get(f.id);
      expect(f.task().screen).toBeUndefined();
      expect(f.engine.drivers.has(f.id)).toBe(false);
      expect(f.engine.getState().inbox.some((item) => item.taskId === f.id && (item.kind === "screen" || item.kind === "question"))).toBe(false);
      expect(copies.every((path) => !existsSync(path))).toBe(true);
      for (const path of registered) expect(await git(f.repo, "worktree", "list", "--porcelain")).not.toContain(path);
    } finally { await f.close(); }

  });
});

it.each([false, true])("keeps earlier peers ahead of later tasks after a usage requeue, retaining Allow now (request allowed: %s)", async (allowed) => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner, "code reviewer", { controlled: true });
    try {
      await owner.run(f.engine, async () => {
        f.engine.setPoolPaused(false);
        const group = await f.group();
        const holder = group.find((entry) => JSON.parse(readFileSync(join(f.fakes.dir, "conversations", `${entry.session}.json`), "utf8")).model === "opus")!;
        const peer = group.find((entry) => entry !== holder)!;
        f.background(holder.session);
        await waitFor(f.waiting, "the first screen request");
        const member = f.task().screen!.member!;
        f.background(peer.session);
        await waitFor(() => Object.keys(f.task().hunt?.screenTurns ?? {}).length === 2 && !f.engine.drivers.has(f.id), "both saved requests");
        const earlier = Object.values(f.task().hunt!.screenTurns!).find((entry) => entry.conversation.sessionId === peer.session)!.at;
        f.fakes.scenario({ ...f.scenario, controlled: false, planner: "short", screen: "hold", limited: [{ model: "opus", role: "code reviewer", onScreen: true }] });
        const later = f.engine.addTask({ productId: f.productId, title: "A later builder's screen request" });
        await waitFor(() => f.engine.getState().tasks.find((task) => task.id === later)?.screen !== undefined, "the later builder to ask");
        expect(earlier).toBeLessThan(f.engine.getState().tasks.find((task) => task.id === later)!.screen!.at);
        f.engine.setPoolPaused(true);
        if (allowed) f.engine.allowScreen(f.id);
        f.engine.setScreenUse("on");
        f.engine.setPoolPaused(false);
        await waitFor(() => f.onScreen().length > 0, "an agent to actually use the screen after the holder's limit");
        expect(f.onScreen()).toEqual([peer.session]);
        expect(f.task().screen?.granted).toBe(true);
        if (allowed) {
          expect(f.task().hunt!.screenTurns![member]?.allowed).toBe(true);
          f.engine.setScreenUse("off");
          f.release(peer.session);
          await waitFor(() => f.onScreen().some((session) => session !== peer.session), "the requeued request's one-time allowance to survive switching Off");
          expect(f.task().screen?.member).toBe(member);
          expect(f.task().screen?.allowed).toBe(true);
          expect(f.engine.getState().tasks.find((task) => task.id === later)!.screen?.granted).not.toBe(true);
        }

      });
    } finally { await f.close(); }

  });
});

it("reopens a saved reviewer once when switching Off during a live grant, keeping its peer's seat and holding its usage replacement", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner, "code reviewer", { controlled: true, screenModels: ["opus"], limited: [{ model: "opus", role: "code reviewer", onScreen: true }] }, { toolPath: () => process.execPath });
    let switchedOff = false;
    const unsubscribe = f.engine.subscribe(() => {
      if (!switchedOff && f.task().screen?.granted) {
        switchedOff = true;
        // The saved member is being admitted by a live group. This update schedules synchronously.
        f.engine.setScreenUse("off");
      }
    });
    try {
      await owner.run(f.engine, async () => {
        f.engine.setPoolPaused(false);
        const group = await f.group();
        const holder = group.find((entry) => JSON.parse(readFileSync(join(f.fakes.dir, "conversations", `${entry.session}.json`), "utf8")).model === "opus")!;
        const peer = group.find((entry) => entry !== holder)!;
        f.background(holder.session);
        await waitFor(() => f.waiting() && !f.engine.screenGroups.get(f.id)?.running(f.task().screen!.member!), "the saved reviewer to yield beside its working peer");
        expect(slotUses(f.engine.getState())).toHaveLength(1);

        f.engine.setScreenUse("on");
        await waitFor(() => f.engine.getState().pool.limited?.length && f.waiting() && !f.engine.screenGroups.get(f.id)?.running(f.task().screen!.member!), "the reopened reviewer to yield after its usage limit");
        expect(switchedOff).toBe(true);
        expect(f.fakes.opens().filter((entry) => entry.session === holder.session).map((entry) => entry.how)).toEqual(["new", "resume"]);
        expect(f.fakes.received("code reviewer").filter((entry) => entry.session === holder.session)).toHaveLength(2);
        expect(slotUses(f.engine.getState())).toHaveLength(1);
        expect(f.task().screen?.granted).not.toBe(true);

        f.background(peer.session);
        await waitFor(() => !f.engine.settling.has(f.id), "the peer and group cleanup to finish while screen use stays Off");
        expect(f.waiting()).toBe(true);
        expect(slotUses(f.engine.getState())).toEqual([]);
        expect(f.engine.inFlight()).toBe(0);
        expect(f.task().hunt?.reported).toEqual({ "1": true });
        const before = f.fakes.received("code reviewer").length;
        await Bun.sleep(200);
        expect(f.fakes.received("code reviewer")).toHaveLength(before);

        f.fakes.scenario({ ...f.scenario, controlled: false });
        f.engine.setScreenUse("on");
        await f.finish();
        expect(f.fakes.received("code reviewer").filter((entry) => entry.session === peer.session)).toHaveLength(1);
        const retries = f.engine.tracking.log.moments({ taskId: f.id, kinds: ["retry"] });
        expect(retries).toEqual([expect.objectContaining({ roleId: "code-reviewer" })]);
        expect(f.task().screen).toBeUndefined();

      });
    } finally { unsubscribe(); await f.close(); }

  });
});

it("resumes the latest fresh conversation after it yields to a peer and its tool recovers", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner, "code reviewer", { controlled: true });
    try {
      await owner.run(f.engine, async () => {
        f.engine.setPoolPaused(false);
        const group = await f.group();
        const holder = group.find((entry) => JSON.parse(readFileSync(join(f.fakes.dir, "conversations", `${entry.session}.json`), "utf8")).model === "opus")!;
        const peer = group.find((entry) => entry !== holder)!;
        f.background(holder.session);
        await waitFor(f.waiting, "the first screen request");
        const member = f.task().screen!.member!;
        f.background(peer.session);
        await waitFor(() => Object.keys(f.task().hunt?.screenTurns ?? {}).length === 2 && !f.engine.drivers.has(f.id), "both reviewers to wait");
        rmSync(join(f.fakes.dir, "conversations", `${holder.session}.json`));
        f.fakes.scenario({ ...f.scenario, controlled: false, limited: [{ model: "opus", role: "code reviewer", onScreen: true }] });
        f.engine.setScreenUse("on");
        await waitFor(() => f.onScreen().includes(peer.session), "the peer to use the screen after the fallback's usage limit");
        const fallback = f.fakes.received("code reviewer").find((entry) => entry.session !== holder.session && entry.session !== peer.session)!;
        expect(fallback).toBeDefined();
        expect(f.task().hunt!.screenTurns![member]!.conversation.sessionId).toBe(fallback.session);
        f.fakes.scenario({ ...f.scenario, controlled: false });
        f.engine.s.pool.limited = [];
        f.engine.s.pool.usage = [];
        f.release(peer.session);
        await waitFor(() => f.onScreen().some((session) => session !== peer.session), "the available fallback to continue");
        expect(f.onScreen()).toEqual(expect.arrayContaining([fallback.session, peer.session]));
        expect(f.fakes.opens().filter((entry) => entry.session === fallback.session).map((entry) => entry.how)).toEqual(["new", "resume"]);
        expect(f.fakes.received("code reviewer").filter((entry) => entry.session === fallback.session).at(-1)!.text).not.toContain("# Your job");

      });
    } finally { await f.close(); }

  });
});

it("keeps a peer's question visible while the other reviewer waits for and uses the screen", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner, "code reviewer", { controlled: true, reviewer: "question", screenModels: ["gpt-6.1-sol"] });
    try {
      await owner.run(f.engine, async () => {
        f.engine.setPoolPaused(false);
        const group = await f.group();
        const question = group.find((entry) => JSON.parse(readFileSync(join(f.fakes.dir, "conversations", `${entry.session}.json`), "utf8")).model === "opus")!;
        const screen = group.find((entry) => entry !== question)!;
        f.background(question.session);
        const item = await waitFor(() => f.engine.getState().inbox.find((entry) => entry.taskId === f.id && entry.kind === "question"), "the reviewer's question");
        f.background(screen.session);
        await waitFor(() => f.engine.getState().inbox.some((entry) => entry.taskId === f.id && entry.kind === "screen"), "the other reviewer's quiet screen request");
        expect(f.task().state).toBe("needs-you");
        f.engine.allowScreen(f.id);
        await waitFor(() => f.onScreen().includes(screen.session), "the other reviewer to use the screen");
        expect(f.task().state).toBe("needs-you");
        f.release(screen.session);
        await waitFor(() => Object.keys(f.task().hunt?.reported ?? {}).length === 1, "the screen check to finish beside the unanswered question");
        expect(f.task().state).toBe("needs-you");
        expect(f.engine.getState().inbox.some((entry) => entry.id === item.id)).toBe(true);
        f.engine.answer(item.id, "Yes");
        await f.finish();

      });
    } finally { await f.close(); }

  });
});

it.each([false, true])("keeps a replacement reviewer's position and conversation across a screen wait, tool recovery and restart (only one tool left: %s)", async (oneTool) => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner, "code reviewer", { limited: [{ model: "opus", role: "code reviewer", spendCap: true }] }, { toolPath: () => process.execPath, usageCommands: { codex: null } });
    const replacement = oneTool ? "sol-high" : "grok-high";
    try {
      f.engine.setPoolLimit(1);
      if (oneTool) f.engine.s.pool.limited = [{ toolId: "grok", until: Date.now() + 3_600_000, reason: "Grok's usage limit" }];
      f.engine.setPoolPaused(false);
      await waitFor(() => f.waiting() && !f.engine.drivers.has(f.id), "the replacement reviewer to wait for the screen", 90_000);
      const session = f.task().conversation!.sessionId;
      expect(f.task().hunt?.profiles?.["0"]).toBe(replacement);
      expect(f.task().screen?.profileId).toBe(replacement);
      expect(f.task().screen?.member).toBe("review-0");
      const summary = f.task().hunt!.work!["reviewer:0"]!;
      expect(summary.todo).toBe("Finished the background checks");
      expect(summary.clock?.since).toBeUndefined();

      // The original tool recovers while this reviewer is waiting. Its own saved conversation still continues.
      f.engine.s.pool.limited = [];
      f.engine.s.pool.usage = [];
      f.fakes.scenario({ ...f.scenario, limited: [] });
      await f.restart();
      expect(f.task().hunt?.profiles?.["0"]).toBe(replacement);
      f.engine.allowScreen(f.id);
      await waitFor(() => f.onScreen().includes(session), "the same replacement conversation on the screen");
      expect(f.task().agent?.reviewKey).toBe("reviewer:0");
      expect(f.task().hunt!.work!["reviewer:0"]!.todo).toBe(summary.todo);
      expect(f.task().hunt!.work!["reviewer:0"]!.clock?.since).toBeDefined();
      expect(f.task().screen?.profileId).toBe(replacement);
      expect(f.fakes.opens().filter((entry) => entry.session === session).map((entry) => entry.how)).toEqual(["new", "resume"]);
      f.engine.setScreenUse("on");
      await f.finish();

      const verdicts = f.engine.tracking.log.moments({ taskId: f.id, kinds: ["verdict"] });
      expect(verdicts.map((entry) => entry.profileId)).toEqual([replacement, oneTool ? "opus-high" : "sol-high"]);
      expect(f.fakes.received("code reviewer").filter((entry) => entry.session === session)).toHaveLength(2);
    } finally { await f.close(); }

  });
});

it.each(["pause", "cancel", "fail"] as const)("removes the saved copies and git records on %s, and can start a paused group fresh", async (action) => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner, "code reviewer");
    try {
      await owner.run(f.engine, async () => {
        f.engine.setPoolPaused(false);
        await waitFor(() => f.waiting() && Object.keys(f.task().hunt?.screenTurns ?? {}).length === 2 && !f.engine.drivers.has(f.id), "both reviewers to wait", 90_000);
        const copies = Object.values(f.task().hunt!.screenTurns!).map((entry) => entry.copy);
        const registeredCopies = copies.map((copy) => realpathSync(copy));
        expect(copies.every(existsSync)).toBe(true);
        if (action === "fail") f.engine.fail(f.id, new Error("A test failure"));
        else f.engine[action](f.id);
        expect(f.engine.getState().inbox.some((item) => item.kind === "screen")).toBe(false);
        if (action === "pause") f.engine.resume(f.id);
        await waitFor(() => action === "pause"
        ? f.waiting() && f.fakes.openings("code reviewer").length === 4 && !f.engine.drivers.has(f.id)
        : copies.every((copy) => !existsSync(copy)), "the old copies to be removed before any fresh group starts", 90_000);
        if (action === "pause") {
          expect(Object.keys(f.task().hunt!.screenTurns!)).toHaveLength(2);
          expect(Object.values(f.task().hunt!.screenTurns!).every((entry) => existsSync(entry.copy))).toBe(true);
        } else {
          await waitFor(() => !f.engine.copyCleanups.has(f.id) && !f.engine.cleanupJobs.has(f.id) && !f.engine.backgroundWork.size, "the copy cleanup and Git registry update to finish");
          const registered = await git(f.repo, "worktree", "list", "--porcelain");
          for (const copy of registeredCopies) expect(registered).not.toContain(copy);
        }

      });
    } finally { await f.close(); }

  });
});

it("keeps an immediate screen reviewer's unanswered question across a restart", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner, "code reviewer", { reviewer: "question", screenModels: ["opus"], screenRoleHold: false });
    try {
      f.engine.setScreenUse("on");
      f.engine.setPoolPaused(false);
      const item = await waitFor(() => {
        const question = f.engine.getState().inbox.find((entry) => entry.taskId === f.id && entry.kind === "question");
        return f.task().screen?.granted && question ? question : undefined;
      }, "the reviewer on the screen to ask", 90_000);
      expect(item.title).toBe("Should the window keep its size?");
      expect(f.task().conversation?.asked).toEqual({ itemId: item.id, question: item.title });
      const session = f.task().conversation!.sessionId;
      await f.restart();
      const kept = f.engine.getState().inbox.find((entry) => entry.id === item.id);
      expect(kept?.kind).toBe("question");
      expect(f.task().state).toBe("needs-you");
      expect(f.task().conversation?.asked).toEqual({ itemId: item.id, question: item.title });
      f.engine.answer(item.id, "Yes");
      const heard = await waitFor(() => f.fakes.received("code reviewer").find((entry) => entry.session === session && entry.text.includes("The coordinator answered your question") && entry.text.includes("Yes")), "the same conversation to hear the answer", 90_000);
      expect(heard.text).toContain("Should the window keep its size?");
    } finally { await f.close(); }

  });
});
