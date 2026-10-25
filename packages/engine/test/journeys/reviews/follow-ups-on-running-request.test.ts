import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { Fakes, waitFor } from "../../fixtures.js";
import { createFollowUpFixtures, STEPS, EVIDENCE, older, groupByBug, taskOf, finish, cards, cardFor, plant } from "../../fixtures/follow-up-native.js";

const { open, close, shutdown } = createFollowUpFixtures();
afterAll(close);

it("reuses an already queued manual bug and a running one held mid-turn, leaving their live work and other requests alone", async () => {
  let mode: "down" | "same" = "down";
  const world = await open(prompt => mode === "down" ? "unavailable" : groupByBug(prompt), true, true);
  const { engine } = world;
  try {
    const fakes = new Fakes(join(world.root, "agents"));
    fakes.scenario({ controlled: true });
    // Requests with the same words that are not candidates: another product, a feature, finished and cancelled work.
    const controls = [
      engine.addTask({ productId: world.notes, kind: "bug", title: "bug-running: The same words on Notes", backlog: true }),
      engine.addTask({ productId: world.shop, title: "bug-running: A feature with the same words", backlog: true }),
      engine.addTask({ productId: world.shop, kind: "bug", title: "bug-queued: A finished earlier fix", backlog: true }),
      engine.addTask({ productId: world.shop, kind: "bug", title: "bug-queued: A cancelled request", backlog: true }),
    ];
    const holds = controls.slice(2).map(id => engine.holdFollowUp(id));
    Object.assign(engine.task(controls[2]!)!, { state: "done", column: "done", finishedAt: Date.now() });
    engine.cancel(controls[3]!);
    const runningId = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-running: Keep the publication check", description: "The coordinator's running request", backlog: true });
    engine.queueTask(runningId);
    engine.setPoolPaused(false);
    // A recorded prompt precedes the agent's plan notification. Snapshot only after the engine
    // consumed that notification, so ordinary in-flight activity cannot be mistaken for a follow-up edit.
    await waitFor(() => fakes.received().length === 1 && engine.task(runningId)!.state === "running" && engine.task(runningId)!.agent?.roleId === "planner" && engine.task(runningId)!.todo === "planner is working", "the coordinator's fix and its recorded plan to hold mid-turn");
    engine.setPoolPaused(true);
    const queuedId = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-queued: Keep planned reviews", description: "The coordinator's queued request", backlog: true });
    engine.queueTask(queuedId);
    const running = engine.task(runningId)!;
    const queued = engine.task(queuedId)!;
    const live = (task: typeof running) => structuredClone({ title: task.title, description: task.description, state: task.state, products: task.selectedProducts, plan: task.plan, stage: task.stageIndex, agent: task.agent, approvals: [task.approvePlan, task.approveDelivery], priority: task.priority, journey: task.journey?.map(step => step.id), rounds: task.rounds, timeline: task.timeline.length, session: task.session.map(line => line.id) });
    const before = { running: live(running), queued: live(queued), driver: engine.drivers.get(runningId), prompts: fakes.received().length };
    const source = taskOf(engine, world.shop, "A later finished task", [
      older("queued", "bug-queued: Publication skips the planned review"),
      older("running", "bug-running: The publication check is skipped after repairs run out"),
      older("fresh", "bug-fresh: An unrelated older bug"),
      older("unsure", "Possibly the same publication problem"),
    ]);
    plant(engine, source.id, source.findings[1]!.text);
    await finish(engine, source);
    // Matching needs a free agent slot. Until it can run, nothing is linked, even though the fix is already active.
    const findings = () => engine.task(source.id)!.findings;
    expect(findings().map(finding => finding.tracking)).toEqual(Array(4).fill({ reason: "unavailable", retry: true }));
    expect([running.followUp, queued.followUp, cards(engine)]).toEqual([undefined, undefined, []]);
    mode = "same";
    await engine["followUps"].catchUp();
    const fresh = cardFor(engine, "fresh");
    expect(findings().map(finding => finding.tracking)).toEqual([{ taskId: queuedId }, { taskId: runningId }, { taskId: fresh[0]!.id }, { reason: "unmatched" }]);
    expect(cards(engine).map(task => task.id).sort()).toEqual([queuedId, runningId, fresh[0]!.id].sort());
    for (const control of controls) {
      expect(engine.task(control)!.followUp).toBeUndefined();
      expect(world.prompts.some(prompt => prompt.includes(`Card [${control}]`))).toBe(false);
    }
    expect(world.prompts.at(-1)).toContain("The coordinator's running request");
    // Only the report credit and its picture are added. The request, plan, stage, agent and queue place stay.
    expect(running.followUp).toMatchObject({ preserveRequest: true, reports: [{ taskId: source.id, findingId: "running", text: source.findings[1]!.text, steps: STEPS, evidence: EVIDENCE }] });
    expect(queued.followUp).toMatchObject({ preserveRequest: true, reports: [{ taskId: source.id, findingId: "queued" }] });
    const added = running.session.filter(line => !before.running.session.includes(line.id));
    expect(added.map(line => [line.from, line.text, line.images?.map(image => image.from)])).toEqual([["system", "Kept from the original report", [{ taskId: source.id, imageId: "pic" }]]]);
    expect(live(running)).toEqual({ ...before.running, session: running.session.map(line => line.id) });
    expect(live(queued)).toEqual(before.queued);
    expect(engine.drivers.get(runningId)).toBe(before.driver);
    expect(fakes.received()).toHaveLength(before.prompts);
    expect(fakes.marked(`release-${fakes.received()[0]!.session}`)).toBe(false);
    // Matching again finds every link already saved: no extra credit, picture or question.
    const asked = world.prompts.length;
    await engine["followUps"].catchUp();
    expect([world.prompts.length, running.followUp!.reports.length, queued.followUp!.reports.length, running.session.length, cards(engine).length]).toEqual([asked, 1, 1, before.running.session.length + 1, 3]);
    holds.forEach(release => release());
  } finally { await shutdown(world.engine); }
});
