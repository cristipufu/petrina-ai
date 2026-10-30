import { expect, it } from "bun:test";
import { publicMessageInput } from "../../fixtures/public-message-input.js";

for (const parallel of [false, true]) it(`saves separate public messages before handoff, including parallel agents (${parallel})`, async () => {
  const f = publicMessageInput(), roleId = parallel ? "code-reviewer" : "builder";
  const profiles = parallel ? ["opus-high", "sol-high"] : ["sol-high"];
  try {
    for (const [index, profileId] of profiles.entries()) {
      const turn = await f.start(roleId, profileId, parallel ? String(index) : undefined);
      const profile = f.profile(profileId)!;
      expect(turn.input.sessionId).toBe(turn.sessionId);
      expect(turn.input.confirmedSettings).toEqual({ model: profile.modelId ?? profile.model, effort: profile.effort });
      expect(turn.input.exact?.digest).toMatch(/^[0-9a-f]{64}$/);
      turn.stream({ id: 1, text: "I'm checking " }); turn.stream({ id: 1, text: "I'm checking the nearby cases." });
      turn.stream({ id: 2, text: "I'm tracing the shared flow." });
      expect(turn.step.endedAt).toBeUndefined();
      turn.stream({ id: 3, text: "The change is ready." });
      const own = f.task.session.filter(line => line.from === "agent" && line.roleId === roleId && line.profileId === profileId);
      expect(own.filter(line => line.text === "I'm checking the nearby cases.")).toHaveLength(1);
      expect(own.filter(line => line.text === "I'm tracing the shared flow.")).toHaveLength(1);
      expect(own.some(line => line.text.startsWith("The change is ready."))).toBe(true);
      expect(own.every(line => !line.text.includes("```"))).toBe(true);
      expect(new Set(own.map(line => line.step)).size).toBe(1);
      expect(own.every(line => line.step === turn.step.id && line.inputIndex === turn.inputIndex)).toBe(true);
    }
    expect(f.calls.commits).toBe(profiles.length * 3); expect(f.calls.updates).toBe(profiles.length);
    expect(f.calls.briefed).toBe(parallel ? 0 : 4);
  } finally { await f.close(); }
});

it("binds same-profile parallel seats independently and ignores duplicate, aborted, stopped and detached updates", async () => {
  const f = publicMessageInput(), stopped = publicMessageInput(), detached = publicMessageInput();
  try {
    const first = await f.start("code-reviewer", "opus-high", "0"), second = await f.start("code-reviewer", "opus-high", "1");
    first.stream({ id: 1, text: "First seat" }); second.stream({ id: 1, text: "Second seat" });
    first.stream({ id: 1, text: "First seat updated" }); first.stream({ id: 1, text: "First seat updated" });
    expect(f.task.session.map(line => [line.text, line.inputIndex])).toEqual([["First seat updated", first.inputIndex], ["Second seat", second.inputIndex]]);
    expect(f.calls).toEqual({ commits: 2, updates: 1, briefed: 0 });
    f.signal.abort(); second.stream({ id: 2, text: "Aborted" });
    const stoppedTurn = await stopped.start("builder", "sol-high"); stopped.stop(); stoppedTurn.stream({ id: 1, text: "Stopped" });
    const detachedTurn = await detached.start("builder", "sol-high"); detached.detach(); detachedTurn.stream({ id: 1, text: "Detached" });
    expect(f.task.session).toHaveLength(2); expect(stopped.task.session).toEqual([]); expect(detached.task.session).toEqual([]);
  } finally { await Promise.all([f.close(), stopped.close(), detached.close()]); }
});
