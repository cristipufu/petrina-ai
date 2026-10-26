import { contextStageFixtures } from "../../fixtures/context-stage.js";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Coordination } from "../../../src/coordination.js";
import { executionFor } from "@petrina/orchestrator";
import { git, waitFor } from "../../fixtures.js";
import { reviewContextFixtures } from "../../fixtures/review-context.js";
const { run, close } = reviewContextFixtures();
afterAll(close);

const prepared = contextStageFixtures();
afterAll(() => prepared.close());

describe.concurrent("reviewer conversations across fix rounds", () => {
for (const { between, shared, single } of [{}, { between: "pause" }, { between: "restart" }, { shared: true }, { single: true }] as { between?: "pause" | "restart"; shared?: boolean; single?: boolean }[]) it(`drops ${single ? "a single reviewer's conversation" : "reviewer conversations"} when main conflicts${shared ? " in one shared product" : ""} and records why on each seat's next start${between ? `, across a ${between} before admission` : ""}`, async () => {
    const exercise = async (f: Awaited<ReturnType<typeof run>>) => {
      try {
        await f.beforeFix();
        const moved = await f.advanceMain(undefined, true);
        const saved = f.task().reviewSessions!;
        const sessions = Object.values(saved).flatMap((seats) => Object.values(seats).map((seat) => seat.sessionId));
        const why = `main conflicted with the change${shared ? ` in ${f.engine().s.products.find((product) => product.id === moved.productId)!.name}` : ""}, so the Builder had to port it`;
        const dropped = Object.fromEntries(Object.entries(saved).map(([stageId, seats]) => [stageId, Object.fromEntries(Object.keys(seats).map((seat) => [seat, why]))]));
        if (between) {
          // Held in the Builder's port: the conversations are already dropped and no reviewer has been admitted.
          const port = join(f.root, "hold-port");
          writeFileSync(port, "");
          writeFixtureJson(join(f.root, "script.json"), { hold: { title: "Bring the work up to date first", file: port } });
          rmSync(f.hold);
          await waitFor(() => { f.tick(); return existsSync(`${port}.reached`); }, "the held conflict port");
          expect(f.task().reviewSessions).toBeUndefined();
          expect(f.task().reviewFreshReasons).toEqual(dropped);
          if (between === "pause") f.engine().pause(f.task().id);
          else await f.restart();
          expect(f.task().reviewFreshReasons).toEqual(dropped);
          rmSync(port);
          if (between === "pause") f.engine().resume(f.task().id);
        }
        const task = await f.done();
        expect(task.timeline.some((entry) => entry.text.includes("Reviewer conversations will start fresh") && entry.text.includes("port"))).toBe(true);
        const [first, second] = task.journey!.filter((step) => step.roleId === "code-reviewer");
        // A first review had no earlier conversation, so nothing describes it as a failed return.
        expect(first!.agentInputs!.every((input) => input.mode === "fresh" && input.freshReason === undefined)).toBe(true);
        expect(second!.agentInputs!.map((input) => input.reviewerKey).sort()).toEqual(Object.keys(Object.values(dropped)[0]!).sort());
        for (const input of second!.agentInputs!) {
          expect([input.mode, input.freshReason]).toEqual(["fresh", why]);
          expect(input.selectionReason).toContain(`Started a fresh conversation: ${why}.`);
          expect(input.taskDescription).toContain("ORIGINAL-REVIEW-REQUEST");
        }
        for (const session of sessions) expect(f.fakes.opens().filter((entry) => entry.session === session).map((entry) => entry.how)).toEqual(["new"]);
        // The compact handoff carries the same explanation, and each start used up its own seat's reason.
        const events = (await new Coordination(f.engine()).call("watch.events", { taskIds: [task.id], from: "oldest", kinds: ["seat.started"], timeoutMs: 0 })).events as { nodeId: string; freshReason?: string; summary: string }[];
        expect(events.filter((event) => event.nodeId === first!.id).map((event) => event.freshReason)).toEqual(first!.agentInputs!.map(() => undefined));
        expect(events.filter((event) => event.nodeId === second!.id)).toHaveLength(second!.agentInputs!.length);
        for (const event of events.filter((event) => event.nodeId === second!.id)) {
          expect(event.freshReason).toBe(why);
          expect(event.summary).toContain(`fresh conversation (${why})`);
        }
        expect(task.reviewFreshReasons).toBeUndefined();
      } finally { await f.shutdown(); }
    };
    if (shared || between === "restart") return exercise(await run(single ? "load" : "resume", { advance: true, shared, single }));
    const f = await prepared.reviewRun(single ? "load" : "resume", { advance: true, shared, single });
    return f.use(() => exercise(f));
  });
});

describe.concurrent("reviewer conversations across fix rounds", () => {
it("stops before reopening reviewers when main replaces the saved base history", async () => {
    const f = await run("resume", { advance: true });
    try {
      await f.beforeFix();
      const product = f.engine().s.products[0]!;
      await git(product.path!, "reset", "--hard", "HEAD~1");
      writeFileSync(join(product.path!, "replacement.txt"), "Different history\n");
      await git(product.path!, "add", "."); await git(product.path!, "commit", "-qm", "Replace the source history");
      await expectRejection(f.done(), "history was replaced or diverged");
      const sessions = new Set(f.fakes.received("code reviewer").map((entry) => entry.session));
      expect(sessions.size).toBe(2);
      expect(f.fakes.opens().filter((entry) => sessions.has(entry.session)).every((entry) => entry.how === "new")).toBe(true);
    } finally { await f.shutdown(); }
  });
});

describe.concurrent("reviewer conversations across fix rounds", () => {
it("returns failed checks on updated code to the Builder before spending another review", async () => {
    const f = await run("resume", { advance: true });
    try {
      await f.beforeFix(); await f.advanceMain();
      writeFileSync(join(f.root, "fail-check"), "");
      const task = await f.done();
      expect(task.journey!.filter((step) => step.roleId === "code-reviewer")).toHaveLength(1);
      expect(executionFor(task).work.checks!.results.some((run) => !run.ok)).toBe(true);
      expect(task.findings.some((finding) => finding.status === "open" && finding.text.startsWith("Check failed"))).toBe(true);
      expect(task.timeline.some((entry) => entry.text.includes("before review"))).toBe(true);
    } finally { await f.shutdown(); }
  });
});

describe.concurrent("reviewer conversations across fix rounds", () => {
it("resumes the actual usage replacement in its own reviewer seat", async () => {
    const f = await prepared.reviewRun("resume", { reviewer: "important-twice", limited: [{ model: "opus", role: "code reviewer", spendCap: true }] });
    return f.use(async () => {
      try {
        const task = await f.done();
        const inputs = task.journey!.filter((step) => step.roleId === "code-reviewer").map((step) => step.agentInputs!);
        const replacement = inputs[0]!.find((input) => input.profileId !== "opus-high" && input.profileId !== "sol-high")!;
        expect(replacement).toBeDefined();
        expect(inputs[1]!.find((input) => input.profileId === replacement.profileId)!.mode).toBe("continued");
        const id = f.fakes.received("code reviewer").find((entry) => f.fakes.settings(entry.session).some((setting) => setting.startsWith("model=grok")))!.session;
        expect(f.fakes.opens().filter((entry) => entry.session === id).map((entry) => entry.how)).toEqual(["new", "resume"]);
      } finally { await f.shutdown(); }
    });
  });
});

describe.concurrent("reviewer conversations across fix rounds", () => {
it("continues a shared-product review with its own detached map and both prepared comparisons", async () => {
    const f = await prepared.reviewRun("resume", { shared: true });
    return f.use(async () => {
      try {
        const task = await f.done();
        const rounds = task.journey!.filter((step) => step.roleId === "code-reviewer");
        expect(rounds).toHaveLength(2);
        expect(rounds[1]!.agentInputs!.every((input) => input.mode === "continued")).toBe(true);
        for (const entry of f.fakes.received("code reviewer").filter((entry) => entry.text.startsWith("Petrina is back"))) {
          expect(entry.text).toContain("Check every point of the saved base");
          expect(entry.text).not.toContain("copy " + task.repositories![0]!.worktree);
          const context = rounds[1]!.agentInputs!.find((input) => input.sections.some((section) => section.title === "Current authoritative task context"))!;
          expect(context).toBeDefined();
        }
        const inputs = rounds[1]!.agentInputs!;
        expect(inputs.every((input) => input.sections.find((section) => section.title === "Prepared review material")!.body.match(/\(reference /g)?.length === 4)).toBe(true);
      } finally { await f.shutdown(); }
    });
  });
});
