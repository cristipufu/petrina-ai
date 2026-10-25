import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Coordination } from "../../../src/coordination.js";
import { executionFor, scopesFor } from "@petrina/orchestrator";
import { readReviewInput } from "../../../src/review-context.js";
import { fullFollowUpCards } from "../../../src/review-history.js";
import { git, waitFor } from "../../fixtures.js";
import { reviewContextFixtures } from "../../fixtures/review-context.js";
const { run, earlier, close } = reviewContextFixtures();
afterAll(close);

describe.concurrent("reviewer conversations across fix rounds", () => {
it("records compact frozen evidence for three fresh reviewers after a real conflict, restart and usage replacement", async () => {
    const f = await run("resume", { advance: true, settledHistory: true, limit: 3 });
    try {
      await f.beforeFix();
      await f.advanceMain(undefined, true);
      const port = join(f.root, "hold-compact-port");
      writeFileSync(port, "");
      writeFixtureJson(join(f.root, "script.json"), { hold: { title: "Bring the work up to date first", file: port } });
      rmSync(f.hold);
      await waitFor(() => { f.tick(); return existsSync(`${port}.reached`); }, "the compact-history conflict port");
      expect(f.task().reviewSessions).toBeUndefined();
      await f.restart();
      // The conflict round needs a fresh replacement as well as fresh planned seats.
      f.fakes.scenario({ planner: "pair", builder: "plain", reviewer: "important", fixes: "change", controlled: true, reopen: "resume", limited: [{ model: "opus", role: "code reviewer" }] });
      rmSync(port);
      const task = await f.done();
      const rounds = task.journey!.filter(step => step.roleId === "code-reviewer" && step.id !== "prior-examination");
      expect(rounds).toHaveLength(2);
      const round = rounds[1]!;
      expect([...new Set(round.agentInputs!.map(input => input.reviewerKey))].sort()).toEqual(["0", "1", "2"]);
      expect(round.agentInputs).toHaveLength(4); // The refused attempt and its replacement both keep receipts.
      const history = task.journey!.filter(step => step.round === round.round && step.reviewInput?.digest === round.reviewInput?.digest && step.reviewHistory);
      expect(history).toHaveLength(1);
      const copy = history[0]!.reviewHistory!;
      expect(createHash("sha256").update(copy.body).digest("hex")).toBe(copy.digest);
      expect(copy.body).toContain("Original settled reproduction and evidence");
      expect(copy.body).toContain("Original independent judgment");
      expect(copy.body).toContain("Original full follow-up evidence");
      const supplied = round.agentInputs!.map(input => {
        expect(input.mode).toBe("fresh");
        if (input.profileId === ["sol-high", "opus-high", "grok-high"][Number(input.reviewerKey)]) expect(input.freshReason).toContain("Builder had to port");
        const text = readFileSync(input.exact!.file, "utf8");
        expect(text).toContain(copy.digest);
        expect(text).not.toContain("Original settled reproduction and evidence");
        expect(text).toContain("ORIGINAL-REVIEW-REQUEST");
        expect(text).toContain("ORIGINAL-DESIGN-BRIEF");
        expect(text).toContain("Prepared review material");
        expect(input.manifest).toContainEqual(expect.objectContaining({ name: "Findings so far (confirm or dispute by id)", kind: "text" }));
        expect(f.fakes.received("code reviewer").filter(entry => entry.session === input.sessionId).map(entry => entry.text)).toContain(text);
        return input.sections.filter(section => ["Findings so far (confirm or dispute by id)", "Open follow-up cards"].includes(section.title));
      });
      for (const sections of supplied) expect(sections).toEqual(supplied[0]!);
      expect(round.agentInputs!.some(input => input.profileId !== ["sol-high", "opus-high", "grok-high"][Number(input.reviewerKey)])).toBe(true);
      const replacement = round.agentInputs!.find(input => input.profileId !== ["sol-high", "opus-high", "grok-high"][Number(input.reviewerKey)])!;
      expect(replacement.sections.some(section => section.title === "Where the agent before you stopped")).toBe(true);
      const frozen = await readReviewInput(round.reviewInput!);
      expect(frozen).toMatchObject({ history: { digest: copy.digest } });
      const complete = new Map([...(frozen.parts.findings ?? []).map(section => [section.title, section.body] as const), ["Open follow-up cards", fullFollowUpCards(frozen.cards)]]);
      const sizes: string[] = [];
      const previous = { ...round, reviewHistory: undefined, agentInputs: round.agentInputs!.map(input => {
        let text = readFileSync(input.exact!.file, "utf8");
        const sections = input.sections.map(section => {
          const body = complete.get(section.title);
          if (body === undefined) return section;
          text = text.replace(section.body, body);
          return { ...section, body };
        });
        sizes.push(`${text.length} -> ${input.exact!.size}`);
        const digest = createHash("sha256").update(text).digest("hex");
        return { ...input, sections, exact: { ...input.exact!, digest, size: text.length, file: input.exact!.file.replace(input.exact!.digest, digest) }, manifest: input.manifest!.map(entry => {
          const body = complete.get(entry.name);
          return body === undefined ? entry : { ...entry, size: body.length, digest: createHash("sha256").update(body).digest("hex").slice(0, 16) };
        }) };
      }) };
      console.log(`History characters actual conflict/restart/replacement: openings by attempt ${sizes.join(", ")}; serialized journey round ${JSON.stringify(previous).length} -> ${JSON.stringify(round).length}; complete reference available. Tokens, cost and time unmeasured.`);
    } finally { await f.shutdown(); }
  });
});

describe.concurrent("reviewer conversations across fix rounds", () => {
for (const mode of ["pair", "single", "shared", "builder-update"] as const) it(`continues each own ${mode} reviewer after main advances, with current full and incremental evidence`, async () => {
    const reopen = mode === "single" ? "load" : "resume";
    const f = await run(reopen, { advance: true, single: mode === "single", shared: mode === "shared" });
    try {
      await f.beforeFix();
      const moved = await f.advanceMain();
      const saved = structuredClone(f.task().reviewSessions!);
      if (mode === "builder-update") {
        const worktree = executionFor(f.task()).work.worktree!;
        await git(worktree, "add", "."); await git(worktree, "commit", "-qm", "The Builder's fix");
        await git(worktree, "merge", "--no-edit", "-m", "The Builder brings main in itself", moved.base);
      }
      f.task().notes = [{ at: 1, text: "REFRESHED-COORDINATOR-INSTRUCTION" }];
      const task = await f.done();
      const rounds = task.journey!.filter((step) => step.roleId === "code-reviewer");
      expect(rounds).toHaveLength(2);
      // A conflict-free update keeps the conversations, so no seat has a dropped-conversation reason waiting.
      expect(task.reviewFreshReasons).toBeUndefined();
      expect(rounds[0]!.agentInputs!.every((input) => input.mode === "fresh" && input.taskDescription?.includes("ORIGINAL-REVIEW-REQUEST"))).toBe(true);
      expect(rounds[0]!.agentInputs!.every((input) => !input.sections.some((section) => section.title.startsWith("Findings so far")))).toBe(true);
      const works = scopesFor(task).map(({ work }) => work);
      const current = works.find((work) => work.productId === moved.productId)!;
      const head = await git(current.worktree!, "rev-parse", "HEAD");
      expect(current.baseSha).toBe(moved.base);
      expect(current.checks!.sha).toBe(head);
      expect(current.checks!.results.every((run) => run.ok && run.output.includes(`CHECKED-CODE:${head}`))).toBe(true);
      for (const input of rounds[1]!.agentInputs!) {
        expect(input.mode).toBe("continued");
        expect(input.freshReason).toBeUndefined();
        expect(input.taskDescription).toBeUndefined();
        expect(input.sections.some((section) => section.title === "Design brief")).toBe(false);
        expect(input.sections.some((section) => section.title === "Current product checks, run by Petrina itself")).toBe(true);
        expect(input.sections.some((section) => section.title === "Related check evidence")).toBe(false);
        expect(input.at).toBeNumber();
        expect(current.checks!.at).toBeLessThanOrEqual(input.at!);
        const update = input.sections.find((section) => section.title === "The review base advanced since your last review")!.body;
        expect(input.manifest).toContainEqual(expect.objectContaining({ name: "The review base advanced since your last review", kind: "text", size: update.length }));
        const exact = readFileSync(input.exact!.file, "utf8");
        expect(exact).toContain(update);
        expect(f.fakes.received("code reviewer").filter((entry) => entry.session === input.sessionId).map((entry) => entry.text)).toContain(exact);
        expect(input.reviewInput).toEqual(rounds[1]!.reviewInput);
        expect(input.reviewInput!.heads[moved.productId]).toBe(head);
        for (const value of [moved.before, moved.base, head, "Main gained 1 commit.", "without an engine conflict port", "overlap.txt", "read their current versions again", "Main's incoming changes are not in the incremental comparison", "complete prepared comparison", "including beyond the files listed above"]) expect(update).toContain(value);
        expect(update.match(/^### /gm)).toHaveLength(1);
        expect(update).toContain(`(${moved.productId})`);
        expect(input.sections.some((section) => section.body.includes("REFRESHED-COORDINATOR-INSTRUCTION"))).toBe(true);
        const material = input.sections.find((section) => section.title === "Prepared review material")!.body;
        const files = [...material.matchAll(/("[^"\n]+\.md") \(reference/g)].map((match) => JSON.parse(match[1]!) as string);
        expect(files).toHaveLength(works.length * 2);
        for (const work of works) {
          expect(material).toContain(`base ${work.baseSha}`);
          expect(work.baseSha).toBe(work.productId === moved.productId ? moved.base : Object.values(saved)[0]!["0"]!.bases![work.productId]);
          expect(work.checks!.current).toBe(true);
          expect(task.journey!.flatMap((step) => step.checkReviews ?? [])).toContainEqual(expect.objectContaining({ productId: work.productId, tree: work.checks!.tree, round: rounds[1]!.round }));
        }
        const changedFiles = files.map((file) => ({ file, body: readFileSync(file, "utf8") })).filter(({ body }) => body.includes(`Product: ${moved.productId}\n`));
        expect(changedFiles).toHaveLength(2);
        for (const { body } of changedFiles) {
          const guide = body.split(/## Complete change|## Changes since/)[0]!;
          expect(guide).toContain("NEW-BASE-GUIDE"); expect(guide).not.toContain("OLD-BASE-GUIDE");
          expect(body).toContain(`Reviewed commit: ${head}`);
        }
        const full = changedFiles.find(({ file }) => file.endsWith(".full.md"))!.body;
        expect(full).toContain(`git diff ${moved.base}...${head}`);
        expect(full).toContain("+Task changes the first line");
        const delta = changedFiles.find(({ file }) => file.endsWith(".incremental.md"))!.body;
        expect(delta).not.toContain("+Task changes the first line");
        expect(delta).not.toContain("+Main changes the last line");
        expect(delta).toContain("welcome.txt");
      }
      const sessions = Object.values(saved).flatMap((seats) => Object.values(seats));
      expect(new Set(sessions.map((seat) => seat.sessionId)).size).toBe(mode === "single" ? 1 : 2);
      for (const seat of sessions) {
        expect(f.fakes.opens().filter((entry) => entry.session === seat.sessionId).map((entry) => entry.how)).toEqual(["new", reopen]);
        const prompts = f.fakes.received("code reviewer").filter((entry) => entry.session === seat.sessionId);
        expect(prompts).toHaveLength(2);
        expect(prompts[1]!.text).not.toContain("ORIGINAL-REVIEW-REQUEST");
        expect(prompts[1]!.text).not.toContain("ORIGINAL-DESIGN-BRIEF");
      }
      const voters = new Set(f.fakes.received("verifier").map((entry) => entry.session));
      expect(voters.size).toBeGreaterThan(0);
      expect(f.fakes.opens().filter((entry) => voters.has(entry.session)).every((entry) => entry.how === "new")).toBe(true);
    } finally { await f.shutdown(); }
  });
});

describe.concurrent("reviewer conversations across fix rounds", () => {
for (const single of [false, true]) it(`omits unchanged closed findings from the actual continued ${single ? "single" : "parallel"} reviewer input`, async () => {
    const f = await run("resume", { single, seedFinding: true });
    try {
      const task = await f.done();
      const first = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 1)!;
      const next = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 2)!;
      expect(first.agentInputs!.every((input) => input.sections.some((section) => section.body.includes(earlier.text)))).toBe(true);
      for (const input of next.agentInputs!) {
        expect(input.mode).toBe("continued");
        expect(input.sections.some((section) => section.title === "Current finding status index" && section.body.includes("older: fixed"))).toBe(true);
        expect(input.sections.map((section) => section.body).join("\n")).not.toContain(earlier.text);
        expect(input.sections.some((section) => section.title.startsWith("New or changed finding records"))).toBe(true);
      }
    } finally { await f.shutdown(); }
  });
});

describe.concurrent("reviewer conversations across fix rounds", () => {
for (const reopen of ["resume", "load"] as const) for (const single of [false, true]) it(`continues ${single ? "one reviewer" : "each parallel reviewer"} with ${reopen}, while voters stay fresh`, async () => {
    const f = await run(reopen, { single, browser: true });
    try {
      const task = await f.done();
      const rounds = task.journey!.filter((step) => step.roleId === "code-reviewer" && step.endedAt);
      expect(rounds).toHaveLength(2);
      expect(rounds[0]!.agentInputs!.every((input) => input.mode === "fresh")).toBe(true);
      expect(rounds[1]!.agentInputs!.every((input) => input.mode === "continued")).toBe(true);
      for (const input of rounds[1]!.agentInputs!) {
        expect(input.taskDescription).toBeUndefined();
        expect(input.sections.some((section) => section.title === "Design brief")).toBe(false);
        expect(input.sections.some((section) => section.title === "Findings so far (confirm or dispute by id)")).toBe(true);
        expect(input.sections.some((section) => section.title === "Current authoritative task context")).toBe(true);
        expect(input.sections.some((section) => section.title === "Prepared review material")).toBe(true);
      }
      const sessions = new Set(f.fakes.received("code reviewer").map((entry) => entry.session));
      expect(sessions.size).toBe(single ? 1 : 2);
      for (const id of sessions) {
        expect(f.fakes.opens().filter((entry) => entry.session === id).map((entry) => entry.how)).toEqual(["new", reopen]);
        const prompts = f.fakes.received("code reviewer").filter((entry) => entry.session === id);
        expect(prompts[0]!.text).toContain(`Browser output belongs only in ${join(f.browsers, "petrina-browser-")}`);
        expect(prompts[1]!.text).toContain(`Browser capture folder for this turn: ${join(f.browsers, "petrina-browser-")}`);
        expect(prompts[1]!.text).not.toContain("Browser output belongs only in");
      }
      const voterIds = new Set(f.fakes.received("verifier").map((entry) => entry.session));
      expect(voterIds.size).toBeGreaterThan(0);
      expect(f.fakes.opens().filter((entry) => voterIds.has(entry.session)).every((entry) => entry.how === "new")).toBe(true);
      expect(Object.values(task.reviewSessions ?? {}).flatMap(seats => Object.values(seats).map(seat => seat.sessionId)).sort()).toEqual([...sessions].sort());
      const copy = JSON.parse(readFileSync(join(f.fakes.dir, "conversations", `${[...sessions][0]}.json`), "utf8")).cwd as string;
      if (!single) expect(existsSync(copy)).toBe(false);
    } finally { await f.shutdown(); }
  });
});

describe.concurrent("reviewer conversations across fix rounds", () => {
it("keeps a queued reviewer blind to a faster peer, including after an engine restart", async () => {
    const f = await run("resume", { limit: 1 });
    try {
      await waitFor(() => { f.tick((role, session) => role !== "code reviewer" || !f.fakes.settings(session).includes("model=gpt-6.1-sol")); return Object.keys(f.task().hunt?.reported ?? {}).length === 1; }, "one blind reviewer to finish");
      const ref = structuredClone(f.task().hunt!.input!);
      const saved = readFileSync(ref.file, "utf8");
      await f.restart();
      const task = await f.done();
      expect(readFileSync(ref.file, "utf8")).toBe(saved);
      const firstRound = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 1)!;
      expect(firstRound.agentInputs!.every((input) => !input.sections.some((section) => section.title === "Findings so far (confirm or dispute by id)"))).toBe(true);
      expect(f.fakes.received("code reviewer").filter((entry) => entry.text.includes("This is review round 2")).every((entry) => entry.text.includes("Findings so far"))).toBe(true);
      expect(task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 2)!.agentInputs!.every((input) => input.mode === "continued")).toBe(true);
    } finally { await f.shutdown(); }
  });
});

describe.concurrent("reviewer conversations across fix rounds", () => {
it("starts fresh with complete inputs when the harness cannot reopen a reviewer", async () => {
    const f = await run(undefined, { advance: true });
    try {
      await f.beforeFix(); await f.advanceMain();
      const task = await f.done();
      const second = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 2)!;
      expect(second.agentInputs!.every((input) => input.mode === "fresh" && input.taskDescription!.includes("ORIGINAL-REVIEW-REQUEST"))).toBe(true);
      expect(task.timeline.some((entry) => entry.text.includes("Could not go back to its own review conversation"))).toBe(true);
      expect(task.hunt).toBeUndefined();
      expect(second.reviewInput?.digest).toBeString();
      expect(second.agentInputs!.every(input => input.reviewInput?.digest === second.reviewInput!.digest)).toBe(true);
      const c = new Coordination(f.engine());
      expect(await c.call("journey.node", { taskId: task.id, nodeId: second.id, limit: 1 })).toMatchObject({ reviewInput: { digest: second.reviewInput!.digest } });
      const heads = await c.call("journey.review-input", { taskId: task.id, nodeId: second.id, section: "versions" });
      expect(JSON.parse(String(heads.text))).toEqual(second.reviewInput!.heads);
      let page = await c.call("journey.review-input", { taskId: task.id, nodeId: second.id, section: "findings", limit: 200 });
      let text = String(page.text);
      while (page.next) { page = await c.call("journey.review-input", { taskId: task.id, nodeId: second.id, section: "findings", limit: 200, cursor: page.next }); text += page.text; }
      expect(JSON.parse(text).length).toBeGreaterThan(0);
      writeFileSync(second.reviewInput!.file, "Changed snapshot");
      expect((await c.call("journey.review-input", { taskId: task.id, nodeId: second.id })).outcome).toBe("changed");
      renameSync(second.reviewInput!.file, `${second.reviewInput!.file}.missing`);
      expect((await c.call("journey.review-input", { taskId: task.id, nodeId: second.id })).outcome).toBe("unavailable");
    } finally { await f.shutdown(); }
  });
});

describe.concurrent("reviewer conversations across fix rounds", () => {
for (const changed of ["context", "absent context", "profile", "source", "bases", "incomplete bases", "native session"] as const) it(`starts the affected seats fresh after ${changed} changes while main advances`, async () => {
    const f = await run("resume", { advance: true });
    try {
      await f.beforeFix(); await f.advanceMain();
      const stage = f.task().plan!.stages.find((entry) => entry.kind === "review-chain")!;
      const prior = f.task().reviewSessions![stage.id]!["0"]!;
      if (changed === "context") {
        // Both seats saved the complete packet; only this seat's reference then loses its file.
        for (const seat of ["0", "1"]) {
          const saved = f.task().reviewSessions![stage.id]![seat]!.context!;
          const packet = readFileSync(saved.file, "utf8");
          expect(createHash("sha256").update(packet).digest("hex")).toBe(saved.digest);
          expect(packet).toContain("ORIGINAL-REVIEW-REQUEST");
        }
        prior.context!.file += ".missing";
      } else if (changed === "absent context") {
        // Context storage is optional: a failed save sends complete instructions without a packet.
        delete prior.context;
      } else if (changed === "profile") stage.profileIds[0] = "opus-xhigh";
      else if (changed === "source") {
        const work = executionFor(f.task()).work;
        work.source!.initialSha = await git(work.worktree!, "rev-parse", `${prior.bases![work.productId]}~1`);
      } else if (changed === "bases") delete prior.bases;
      else if (changed === "incomplete bases") prior.bases = {};
      else rmSync(join(f.fakes.dir, "conversations", `${prior.sessionId}.json`));
      const task = await f.done();
      const inputs = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 2)!.agentInputs!;
      expect(inputs.find((input) => input.reviewerKey === "0")!.mode).toBe("fresh");
      expect(inputs.find((input) => input.reviewerKey === "1")!.mode).toBe(changed === "source" ? "fresh" : "continued");
      expect(inputs.find((input) => input.mode === "fresh")!.taskDescription).toContain("ORIGINAL-REVIEW-REQUEST");
      expect(inputs.find((input) => input.mode === "fresh")!.sections.some((section) => section.title === "Design brief")).toBe(true);
      expect(inputs.filter((input) => input.mode === "fresh").every((input) => !input.sections.some((section) => section.title === "The review base advanced since your last review"))).toBe(true);
      const reason = changed === "context" || changed === "absent context" ? "saved context is unavailable" : changed === "bases" || changed === "incomplete bases" ? "saved repository bases are unavailable" : changed === "native session" ? "Could not go back to its own review conversation" : changed === "profile" ? "you changed who works on this seat" : "role, profile, request or starting point changed";
      expect(task.timeline.some((entry) => entry.text.includes(reason))).toBe(true);
      // The recorded fresh reason is the one the selection gave, including a reopen failure discovered before instructions.
      for (const input of inputs) {
        if (input.mode === "continued") expect(input.freshReason).toBeUndefined();
        else if (changed === "native session") expect(input.freshReason).toContain("could not reopen the conversation");
        else expect(input.freshReason).toBe(changed === "profile" ? reason : `its ${reason}`);
      }
    } finally { await f.shutdown(); }
  });
});
