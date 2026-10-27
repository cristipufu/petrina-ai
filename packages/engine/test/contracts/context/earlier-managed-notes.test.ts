import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll } from "bun:test";
import { completeAll } from "@petrina/core";
import { nativeCoordinatorTask } from "../../fixtures/coordinator-native.js";
import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationNote } from "@petrina/core";
import { BuildResult } from "../../../src/roles.js";
import { waitFor } from "../../fixtures.js";
const cases = engineCaseFixtures();
afterAll(() => cases.close());


it("records an older conversation's retry without resupplying guidance actually delivered after its saved snapshot", async () => {
  return cases.use("petrina-earlier-note-managed-", owner => nativeCoordinatorTask(owner, async ({ fakes, engine, task, scope, dispose: close }) => {
  const controllers: AbortController[] = [];
  const pending: Promise<unknown>[] = [];
    owner.onStop(async () => { await completeAll([...controllers.map(async controller => { controller.abort(); }), Promise.allSettled(pending).then(() => undefined)]); });
  try {
    task.plan = { rationale: "Build only", plannerProfileId: "sol-high", stages: [{ id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] }] };
    task.stageIndex = 0;
    task.notes = [{ id: "old", at: 1, text: "ORIGINAL DECISION SAVED BEFORE THE MESSAGE", origin: { stageTitle: "Original decision", roleName: "Coordinator" } }];
    const run = async (resume?: ConversationNote) => {
      owner.check();
      const index = fakes.received("builder").length;
      const controller = new AbortController(); controllers.push(controller);
      task.state = "running"; task.holdsSlot = true;
      task.agent = { roleId: "builder", profileId: "sol-high", since: Date.now(), step: 0 };
      const result = engine["turns"].turn(scope, "builder", "sol-high", () => engine["context"].sectionsFor(scope, "builder"), BuildResult, controller.signal, { ...(resume ? { resume } : {}) });
      pending.push(result); result.catch(() => {});
      const opening = await waitFor(() => fakes.received("builder")[index], "the earlier-guidance recording", undefined, { during: result });
      writeFileSync(join(fakes.dir, `release-${opening.session}`), "go");
      await result;
      const input = task.journey!.at(-1)!.agentInputs!.at(-1)!;
      expect(readFileSync(input.exact!.file, "utf8")).toBe(opening.text);
      return { opening, input, saved: structuredClone(scope.work.conversation!) };
    };
    const first = await run();
    engine.finishStep(scope);
    const message = "MESSAGE ACTUALLY HEARD AFTER THE OLD SAVED SNAPSHOT";
    const id = engine.sendMessage(task.id, message, "queue")!;
    const receipt = task.queued[0]!;
    const heard = await run(first.saved);
    expect(heard.opening.session).toBe(first.opening.session);
    expect(heard.opening.text.split(message)).toHaveLength(2);
    expect(receipt.deliveries?.main?.state).toBe("applied");
    expect(task.stepNotes).toContainEqual(expect.objectContaining({ id, text: message }));
    const receiptBefore = structuredClone(receipt), linesBefore = structuredClone(task.session.filter(line => line.from === "you"));
    // A retried step can return to an earlier-round snapshot of this native conversation.
    delete scope.work.conversation;
    const returned = await run(first.saved);
    expect(scope.work.stepAttempts).toBe(2);
    expect(returned.input.mode).toBe("continued");
    expect(returned.opening.session).toBe(first.opening.session);
    expect(returned.opening.text).not.toContain(message);
    expect(returned.opening.text).not.toContain(task.notes![0]!.text);
    const notes = returned.input.sections.find(section => section.title.startsWith("The coordinator's notes"))!.body;
    expect(notes).toContain(id);
    expect(notes).toMatch(/earlier[- ]attempt/i);
    expect(returned.input.sections.some(section => section.title === "Messages from the coordinator, in order")).toBe(false);
    expect(receipt).toEqual(receiptBefore);
    expect(task.queued).toEqual([]);
    expect(task.session.filter(line => line.from === "you")).toEqual(linesBefore);
    const packet = readFileSync(returned.saved.context!.file, "utf8");
    expect(createHash("sha256").update(packet).digest("hex")).toBe(returned.saved.context!.digest);
    for (const entry of task.notes!) expect(packet.split(entry.text)).toHaveLength(2);
    expect(packet.indexOf(task.notes![0]!.text)).toBeLessThan(packet.indexOf(message));
  } finally {
    controllers.forEach(controller => controller.abort());
    await Promise.allSettled(pending);
    await close();
  }

  }, "Keep earlier-attempt guidance", { builder: "plain", reopen: "resume", controlled: true }));
});
