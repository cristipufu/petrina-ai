import { emptyState, task, disagreeing, reshaped, inboxItem, tickUntil, reviewerRuns } from "../../fixtures/simulator.js";
import { describe, expect, it } from "vitest";

import { CALL_WORDS } from "../../../src/call.js";

import { JOURNEY_WORDS as W } from "../../../src/journey.js";

import type { Stage } from "../../../src/model.js";

import { Simulator } from "../../../src/sim.js";
import { readCall } from "../../../src/sim-script.js";

describe("The coordinator's call on a design disagreement", () => {
  const CALL = "Accept the blocking point: keep the confirmation step only for existing accounts.";

  const objections = [
    { id: "b", blocking: true, text: "The answer for existing accounts adds a confirmation step to notifications that slows everyone down." },
    { id: "m", blocking: false, text: "Consider a short note telling existing users what changed." },
  ];

  const read = (words: string) => Object.fromEntries(readCall(words, objections, "notifications"));

  const clearCalls: readonly [string, Partial<Record<"b" | "m", "accepted" | "rejected">>][] = [
    ["Reject the blocking point in any case.", { b: "rejected" }],
    ["Reject the blocking point no matter what.", { b: "rejected" }],
    ["Reject both points without exception.", { b: "rejected", m: "rejected" }],
    ["Side with the architect in any case.", { b: "rejected", m: "rejected" }],
    ["Reject the blocking point, whether or not the note stays.", { b: "rejected" }],
    ["Reject the blocking point, whether or not it stays.", { b: "rejected" }],
    ["Reject the blocking point, whether or not the confirmation step stays.", { b: "rejected" }],
    ["Reject the blocking point, whether or not the step stays.", { b: "rejected" }],
    ["Accept the short note, whether or not the note stays.", { m: "accepted" }],
    ["Accept the short note, whether or not the blocking point stays.", { m: "accepted" }],
    ["Reject both points, whether or not the note stays.", { b: "rejected", m: "rejected" }],
    ["Accept the short note in any case.", { m: "accepted" }],
    ["Accept both without exception.", { b: "accepted", m: "accepted" }],
    ["Reject it: the blocking point.", { b: "rejected" }],
    ["Reject it (the blocking point).", { b: "rejected" }],
    ["Reject — the blocking point.", { b: "rejected" }],
    ["Accept it: the short note.", { m: "accepted" }],
    ["Don't, in any case, reject the blocking point.", { b: "accepted" }],
    ["I will not, in any case, reject the blocking point.", { b: "accepted" }],
    ["Do not, in any case, accept the blocking point.", { b: "rejected" }],
    ["Never, without exception, reject the blocking point.", { b: "accepted" }],
    ["I refuse to, no matter what, accept the blocking point.", { b: "rejected" }],
    ["The minor one, side with the reviewer, and the blocking one, side with the architect.", { b: "rejected", m: "accepted" }],
    ["For the minor one, side with the reviewer, and for the blocking one, side with the architect.", { b: "rejected", m: "accepted" }],
    ["Regarding the blocking point, side with the architect, and regarding the minor point, side with the reviewer.", { b: "rejected", m: "accepted" }],
    ["The blocking one, side with the reviewer, and the minor one, side with the architect.", { b: "accepted", m: "rejected" }],
    ["The minor one, side with the reviewer. The blocking one, side with the architect.", { b: "rejected", m: "accepted" }],
    ["The minor one, accept it, and the blocking one, reject it.", { b: "rejected", m: "accepted" }],
    ["For the minor one, accept it, and for the blocking one, reject it.", { b: "rejected", m: "accepted" }],
    ["For the minor one, side with the reviewer, and for the blocking one, reject it.", { b: "rejected", m: "accepted" }],
    ["For the minor one, accept it, and for the blocking one, side with the architect.", { b: "rejected", m: "accepted" }],
    ["Side with the reviewer on the minor point and the architect for the blocking one.", { b: "rejected", m: "accepted" }],
    ["Side with the reviewer on the minor point and the architect about the blocking one.", { b: "rejected", m: "accepted" }],
    ["Side with the reviewer for the minor point and the architect about the blocking one.", { b: "rejected", m: "accepted" }],
    ["Side with the reviewer about the minor point and the architect for the blocking one.", { b: "rejected", m: "accepted" }],
    ["Side with the architect for the blocking one and the reviewer about the minor one.", { b: "rejected", m: "accepted" }],
    ["Side with the reviewer for the blocking one and the architect about the minor one.", { b: "accepted", m: "rejected" }],
    ["Reject every one of them.", { b: "rejected", m: "rejected" }],
    ["Accept every one of them.", { b: "accepted", m: "accepted" }],
    ["Reject each one of them.", { b: "rejected", m: "rejected" }],
    ["Accept each one of them.", { b: "accepted", m: "accepted" }],
    ["Reject every one.", { b: "rejected", m: "rejected" }],
    ["Accept each one.", { b: "accepted", m: "accepted" }],
    ["Do not accept every one of them.", { b: "rejected", m: "rejected" }],
    ["Accept each one of them except the blocking point.", { b: "rejected", m: "accepted" }],
    ...["every", "each"].flatMap((all) => ["", "single ", "last "].flatMap((emphasis) => ["them", "the points", "the objections"].flatMap((points): typeof clearCalls[number][] => [
      [`Reject ${all} ${emphasis}one of ${points}.`, { b: "rejected", m: "rejected" }],
      [`Accept ${all} ${emphasis}one of ${points}.`, { b: "accepted", m: "accepted" }],
    ]))),
    ["Reject the blocking point whether or not the note stays.", { b: "rejected" }],
    ["Reject the blocking point, whether or not the note stays, and accept the short note.", { b: "rejected", m: "accepted" }],
    ...["answer", "answers", "note", "notes", "confirmation", "confirmations"].flatMap((reply): typeof clearCalls[number][] => [
      [`Side with the architect's ${reply}.`, { b: "rejected", m: "rejected" }],
      [`Side with the reviewer's ${reply}.`, { b: "accepted", m: "accepted" }],
    ]),
    ...["in any case", "no matter what", "without exception"].flatMap((emphasis): typeof clearCalls[number][] => [
      [`${emphasis} reject the blocking point.`, { b: "rejected" }],
      [`${emphasis} reject the blocking point and accept the short note.`, { b: "rejected", m: "accepted" }],
      [`Reject the blocking point ${emphasis} and accept the short note.`, { b: "rejected", m: "accepted" }],
      [`Reject the blocking point ${emphasis}: the confirmation step stays.`, { b: "rejected" }],
      [`Reject (${emphasis}) the blocking point.`, { b: "rejected" }],
      [`Reject — ${emphasis} — the blocking point.`, { b: "rejected" }],
      [`Reject, ${emphasis}, the blocking point.`, { b: "rejected" }],
      [`Do not (${emphasis}) accept the blocking point.`, { b: "rejected" }],
      [`Don't — ${emphasis} — reject the blocking point.`, { b: "accepted" }],
    ]),
    ["Accept the short note, while rejecting the blocking point.", { b: "rejected", m: "accepted" }],
    ["Accept the short note while rejecting the blocking point.", { b: "rejected", m: "accepted" }],
    ["Accept the short note while rejecting the blocking point that stays.", { b: "rejected", m: "accepted" }],
    ["Reject the blocking point while accepting that the note stays.", { b: "rejected", m: "accepted" }],
    ["While rejecting the blocking point that stays, accept the short note.", { b: "rejected", m: "accepted" }],
    ["While rejecting the blocking point.", { b: "rejected" }],
    ["While siding with the architect on the blocking point.", { b: "rejected" }],
    ["Reject the minor point while siding with the architect on the blocking one.", { b: "rejected", m: "rejected" }],
    ["Reject the blocking point, while accepting the short note.", { b: "rejected", m: "accepted" }],
    ["Reject the blocking point, while keeping the note short.", { b: "rejected" }],
    ["While keeping the note short, reject the blocking point.", { b: "rejected" }],
    ["Reject the blocking point, while keeping the note that helps.", { b: "rejected" }],
    ["While keeping the note that helps, reject the blocking point.", { b: "rejected" }],
    ["Reject the blocking point, while keeping the note which helps.", { b: "rejected" }],
    ["While keeping the note which helps, reject the blocking point.", { b: "rejected" }],
    ["Reject the blocking point, while keeping the note that still helps.", { b: "rejected" }],
    ["While keeping the note that still helps, reject the blocking point.", { b: "rejected" }],
    ["Reject the blocking point that still helps.", { b: "rejected" }],
    ["Accept the short note which helps.", { m: "accepted" }],
    ["While rejecting the blocking point that is optional, accept the short note.", { b: "rejected", m: "accepted" }],
    ["Accept the short note while rejecting the blocking point that is optional.", { b: "rejected", m: "accepted" }],
    ["Reject the blocking point that is optional.", { b: "rejected" }],
    ["Don't reject the blocking point that is optional.", { b: "accepted" }],
    ["Accept the short note that helps.", { m: "accepted" }],
    ["Reject the confirmation step.", { b: "rejected" }],
    ["Reject the confirmation step which helps.", { b: "rejected" }],
    ["Reject the step which helps.", { b: "rejected" }],
    ["Reject the confirmation step that still helps.", { b: "rejected" }],
    ["Reject the confirmation step that is optional.", { b: "rejected" }],
    ["While keeping the confirmation step which helps, reject the blocking point.", { b: "rejected" }],
    ["While rejecting the confirmation step that is optional, accept the short note.", { b: "rejected", m: "accepted" }],
    ["Accept the suggestion.", { m: "accepted" }],
    ["Accept the suggestion that helps.", { m: "accepted" }],
    ["Accept the minor suggestion that helps.", { m: "accepted" }],
    ["Reject everything except the short note.", { b: "rejected", m: "accepted" }],
    ["Reject everything except the note which helps.", { b: "rejected", m: "accepted" }],
    ["Reject everything except the note that still helps.", { b: "rejected", m: "accepted" }],
    ["Reject all but the note that helps.", { b: "rejected", m: "accepted" }],
    ["Reject the blocking point, not the note which helps.", { b: "rejected", m: "accepted" }],
    ["Accept the blocking point and the short note.", { b: "accepted", m: "accepted" }],
    ["Accept the blocking point and the note which helps.", { b: "accepted", m: "accepted" }],
    ["Accept the blocking point and the short note that helps.", { b: "accepted", m: "accepted" }],
    ["Accept the blocking point and the note that is optional.", { b: "accepted", m: "accepted" }],
    ["Reject the confirmation step that is now optional.", { b: "rejected" }],
    ["Don't reject the confirmation step which helps.", { b: "accepted" }],
    ["Accept the short note which still is optional.", { m: "accepted" }],
    ["Accept the suggestion that remains an open question.", { m: "accepted" }],
    ["While rejecting the blocking point that is optional.", { b: "rejected" }],
    ["Reject the short note. Accepting the short note is still open.", { m: "rejected" }],
    ["Accept the blocking point. It is optional to reject the blocking point.", { b: "accepted" }],
    ["Accept the blocking point. While rejecting the blocking point remains optional.", { b: "accepted" }],
    ["Accept the blocking point. Rejecting the blocking point is optional.", { b: "accepted" }],
    ["Accept both points. While rejecting the blocking point is optional.", { b: "accepted", m: "accepted" }],
    ["Reject both points. While accepting the short note is still open.", { b: "rejected", m: "rejected" }],
    ["Accept both points. While keeping the note is optional.", { b: "accepted", m: "accepted" }],
    ["Accept both points. While siding with the architect is optional.", { b: "accepted", m: "accepted" }],
    ["Accept the short note. While rejecting the blocking point is optional.", { m: "accepted" }],
    ["Reject the blocking point. While accepting the short note is optional.", { b: "rejected" }],
    ["Accept the short note. While keeping it helps.", { m: "accepted" }],
    ["Either way, reject the blocking point.", { b: "rejected" }],
    ["Reject the blocking point, either way.", { b: "rejected" }],
    ["Regardless, reject the blocking point.", { b: "rejected" }],
    ["Accept the blocking point and the note about what changed.", { b: "accepted", m: "accepted" }],
    ["Accept the note about what changed.", { m: "accepted" }],
    ["Accept the blocking point, and the note about what changed.", { b: "accepted", m: "accepted" }],
    ["Accept the minor point and the architect to review the blocking one.", { m: "accepted" }],
    ["Side with the reviewer on the minor point and the architect to review the blocking one.", { m: "accepted" }],
    ["Accept the minor point and the architect about the blocking one can wait.", { m: "accepted" }],
    ["Accept the minor point and the architect for the blocking one.", { m: "accepted" }],
  ];

  it.each(clearCalls)("keeps clear call regressions settled, including a later correction: %s", (words, expected) => {
    expect(read(words)).toEqual(expected);
    const decisions = new Map(Object.entries(expected));
    const { sim, id } = disagreeing();
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    const check = tickUntil(sim, "design");
    const settled = task(sim, id);
    const due = settled.call!.open;
    for (const objection of settled.objections.filter((entry) => due.includes(entry.id))) {
      const decision = decisions.get(objection.blocking ? "b" : "m");
      expect(objection.status).toBe(decision ?? (objection.blocking ? "accepted" : "rejected"));
      expect(objection.call).toBe(decision ? words : undefined);
    }

    // Put every point on the other side first, so the same wording must now correct an answer.
    const reset = objections.map(({ id, blocking }) => `${decisions.get(id) === "accepted" ? "Reject" : "Accept"} the ${blocking ? "blocking point" : "minor one"}`).join(" and ");
    sim.requestChanges(check.id, reset);
    const again = tickUntil(sim, "design");
    const before = task(sim, id);
    sim.requestChanges(again.id, words);
    tickUntil(sim, "design");
    const after = task(sim, id);
    for (const objection of after.objections.filter((entry) => due.includes(entry.id))) {
      const previous = before.objections.find((entry) => entry.id === objection.id)!;
      const decision = decisions.get(objection.blocking ? "b" : "m");
      expect(objection.status).toBe(decision ?? previous.status);
      expect(objection.call).toBe(previous.call);
      if (decision) expect(objection.answer).toContain("your note");
    }
    expect(reviewerRuns(after)).toBe(reviewerRuns(before));
    expect(after.rounds).toEqual(before.rounds);
  });

  it.each([
    "Accept the blocking point if it is optional.",
    "Reject the blocking point if it stays.",
    "Accept the blocking point, whether it is right.",
    "If it is optional, accept the blocking point.",
    "Reject the blocking point unless it stays.",
    "Do not, if it stays, accept the blocking point.",
    "Reject the blocking point, whether or not it stays if the minor point is optional.",
    "Reject the blocking point, whether it stays or goes.",
    "Don't, perhaps, reject the blocking point.",
    "Never, possibly, accept the blocking point.",
    "Accept the minor point and don't, perhaps, reject the blocking point.",
    "Reject the blocking point, or accept the short note.",
    "Accept the blocking point or reject the short note.",
    "Side with the reviewer, or side with the architect on the blocking point.",
    "Reject the blocking point. Or accept the short note.",
    "Accept the short note. Or reject the blocking point.",
    "Reject the blocking point, or the minor one.",
    "Either reject the blocking point or accept the short note.",
    "I might reject the blocking point.",
    "I may accept the blocking point.",
    "I might, after checking, reject the blocking point.",
    "I may (in any case) accept the blocking point.",
    "I might side with the architect on the minor point.",
    "Reject the blocking point and I may accept the minor one.",
    "Reject the blocking point when the note stays.",
    "Reject the blocking point whenever the note stays.",
    "Accept the short note where it helps.",
    "When the note stays, reject the blocking point.",
    "Whenever the note stays, reject the blocking point.",
    "Where it helps, accept the short note.",
    "Reject the blocking point in any case when the note stays.",
    "Accept each one of them if the step is optional.",
    "Accept one of them.",
    "Reject any one of them.",
    "Accept both (without exception) except the short note.",
    "Accept both, without exception, except the short note.",
    "Accept both — without exception — except the short note.",
    "Reject the blocking point, maybe.",
    "Reject the blocking point, perhaps.",
    "Reject the blocking point, possibly.",
    "Reject the blocking point, I might.",
    "Reject the blocking point, I may.",
    "Maybe, reject the blocking point.",
    "Perhaps, reject the blocking point.",
    "Possibly, reject the blocking point.",
    "Reject the blocking point while the note stays.",
    "Reject the blocking point while the note is optional.",
    "Reject the blocking point, while the note is optional.",
    "While the note is optional, reject the blocking point.",
    "While rejecting the blocking point is optional, accept the short note.",
    "While keeping the note is optional, reject the blocking point.",
    "While rejecting the blocking point remains open, accept the short note.",
    "While accepting the short note is optional, reject the blocking point.",
    "While siding with the architect is optional, accept the short note.",
    "Reject the blocking point while accepting the short note is still open.",
    "Accept the short note while keeping it helps.",
    "While rejecting the blocking point is optional.",
    "While rejecting the blocking point remains optional.",
    "While rejecting the blocking point is still optional.",
    "While accepting the short note is still open.",
    "It is optional to reject the blocking point.",
    "It is still optional to reject the blocking point.",
    "It is optional to accept the short note.",
    "It is optional to side with the architect.",
    "Rejecting the blocking point is optional.",
    "Accepting the short note is optional.",
    "Siding with the architect is optional.",
    "Rejecting the blocking point remains optional.",
    "Accepting the short note is still optional.",
    "Rejecting the blocking point stays open.",
    "Accepting the short note is still open.",
    "Rejecting the blocking point remains open.",
    "Accepting both points are optional.",
    "Reject the blocking point, which is optional.",
    "Reject the blocking point, which is still open.",
    "Reject the blocking point, which remains optional.",
    "Reject the blocking point, which stays open.",
    "Reject the blocking point, this is optional.",
    "Reject the blocking point (this is optional).",
    "Reject the blocking point, that is optional.",
    "Reject the blocking point, that is still optional.",
    "Reject the blocking point, that is still open.",
    "Reject the blocking point, that stays open.",
    "Reject the blocking point, that remains optional.",
    "Reject the blocking point, that remains open.",
    "Reject the blocking point, that helps.",
    "Reject the blocking point (that is optional).",
    "Reject the blocking point (that helps).",
    "Reject the blocking point — that helps.",
    "Reject the blocking point — that is optional.",
    "Side with the architect, that is optional.",
    "Side with the reviewer, that is optional.",
    "While rejecting that is optional, accept the short note.",
    "While keeping that helps.",
    "Reject the blocking point while keeping that helps.",
    "While keeping that helps, reject the blocking point.",
    "Accept the short note while keeping that helps.",
    "It's optional to reject the blocking point.",
    "It’s optional to reject the blocking point.",
    "It's optional to accept the short note.",
    "It's optional to side with the architect.",
    "It's open to reject the blocking point.",
    "It’s open to accept the short note.",
    "It's still open to reject the blocking point.",
    "It's now open to reject the blocking point.",
    "It's left open to reject the blocking point.",
    "It's open to side with the architect.",
    "It is now open to reject the blocking point.",
    "Rejecting the blocking point is now open.",
    "Accepting both points are now open.",
    "While rejecting the blocking point is now open, accept the short note.",
    "Rejecting the blocking point is still left open.",
    "Rejecting the blocking point is now left open.",
    "Rejecting the blocking point is an optional choice.",
    "It is an optional choice to reject the blocking point.",
    "Rejecting the blocking point remains an open question.",
    "Reject the blocking point (this is now open).",
    "Reject the blocking point, that is now open.",
    "Reject the blocking point — which is now open.",
    "Reject the blocking point (it's open).",
    "Reject the blocking point, it's open.",
    "Reject the confirmation step which helps if the note stays.",
    "Accept the blocking point and the note which helps, maybe.",
    "Reject everything except the note which helps, or accept both points.",
    "Reject the blocking point, it's optional.",
    "Reject the blocking point (it's optional).",
    "Optionally reject the blocking point.",
    "Rejecting the blocking point is open.",
    "Rejecting the blocking point is now optional.",
    "Rejecting the blocking point is left open.",
    "Reject the blocking point (this is still open).",
    "Reject the blocking point (this remains optional).",
    "Reject the blocking point (this stays open).",
    "While keeping the note is optional.",
    "While siding with the architect is optional.",
    "While keeping it helps.",
    "While rejecting the blocking point remains open.",
    "Reject the blocking point while it remains.",
    "While it remains, reject the blocking point.",
    "Accept the short note while it helps.",
    "While it helps, accept the short note.",
    "Reject the blocking point in case the note stays.",
    "Accept the blocking point provided the note stays.",
    "Reject the blocking point as long as the note stays.",
    "Reject the blocking point, assuming the note stays.",
    "While the note stays, reject the blocking point.",
    "In case the note stays, reject the blocking point.",
    "Provided the note stays, accept the blocking point.",
    "As long as the note stays, reject the blocking point.",
    "Assuming the note stays, reject the blocking point.",
    "Reject the blocking point. Alternatively, accept the short note.",
    "Reject the blocking point, alternatively accept the short note.",
    "Reject every one of the points if the step is optional.",
    "Accept every single one of them, maybe.",
    "Reject every last one of the objections or accept the blocking point.",
  ])("leaves conditions and unclear asides unresolved, including at the design check: %s", (words) => {
    expect(read(words)).toEqual({});
    const { sim, id } = disagreeing();
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    let check = tickUntil(sim, "design");
    const settled = task(sim, id);
    for (const objection of settled.objections.filter((entry) => settled.call!.open.includes(entry.id))) {
      expect(objection.status).toBe(objection.blocking ? "accepted" : "rejected");
      expect(objection.call).toBeUndefined();
    }
    expect(check.body).toContain("Your call settled 0 objections");

    for (const reset of ["Accept both points.", "Reject both points."]) {
      sim.requestChanges(check.id, reset);
      check = tickUntil(sim, "design");
      const before = task(sim, id).objections;
      sim.requestChanges(check.id, words);
      check = tickUntil(sim, "design");
      expect(task(sim, id).objections.map(({ id, status, call }) => ({ id, status, call }))).toEqual(before.map(({ id, status, call }) => ({ id, status, call })));
    }
  });

  it.each([
    "Side with the reviewer on the minor point and I checked with the architect on the blocking point.",
    "Side with the reviewer on the minor point, after talking with the architect about the blocking point.",
    "Side with the reviewer on the minor point and I spoke with the architect on the blocking point.",
  ])("does not take a conversation with the architect as a decision: %s", (words) => {
    expect(read(words)).toEqual({ m: "accepted" });
    const { sim, id } = disagreeing();
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    const check = tickUntil(sim, "design");
    const settled = task(sim, id);
    for (const objection of settled.objections.filter((entry) => settled.call!.open.includes(entry.id))) {
      expect(objection.status).toBe("accepted");
      expect(objection.call).toBe(objection.blocking ? undefined : words);
    }
    expect(check.body).toContain("Your call settled 1 objection (1 accepted, 0 rejected)");

    sim.requestChanges(check.id, words);
    tickUntil(sim, "design");
    const blocking = task(sim, id).objections.find((entry) => entry.blocking && settled.call!.open.includes(entry.id))!;
    expect(blocking.status).toBe("accepted");
    expect(blocking.call).toBeUndefined();
    expect(read("Side with the reviewer on the minor point and with the architect on the blocking point.")).toEqual({ b: "rejected", m: "accepted" });
  });

  it.each(["answer", "answers", "note", "notes", "confirmation", "confirmations"])("keeps each side's %s with its named point", (reply) => {
    for (const preposition of ["on", "about", "for", "to"]) {
      expect(read(`Accept the architect's ${reply} ${preposition} the blocking one.`)).toEqual({ b: "rejected" });
      expect(read(`Reject the architect's ${reply} ${preposition} the minor one.`)).toEqual({ m: "accepted" });
      for (const action of ["Accept", "Reject", "Side with the reviewer on"]) {
        const words = `${action} the minor point and the architect's ${reply} ${preposition} the blocking one.`;
        const expected = action === "Reject" ? { b: "accepted", m: "rejected" } : { b: "rejected", m: "accepted" };
        expect(read(words)).toEqual(expected);
        const { sim, id } = disagreeing();
        sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
        const check = tickUntil(sim, "design");
        const due = task(sim, id).call!.open;
        for (const objection of task(sim, id).objections.filter((entry) => due.includes(entry.id))) {
          expect(objection.status).toBe(expected[objection.blocking ? "b" : "m"]);
          expect(objection.call).toBe(words);
        }
        sim.requestChanges(check.id, action === "Reject" ? "Reject the blocking point and accept the minor one." : "Accept the blocking point and reject the minor one.");
        const again = tickUntil(sim, "design");
        sim.requestChanges(again.id, words);
        tickUntil(sim, "design");
        for (const objection of task(sim, id).objections.filter((entry) => due.includes(entry.id))) {
          expect(objection.status).toBe(expected[objection.blocking ? "b" : "m"]);
        }
      }
      const words = `Side with the architect on the blocking point and the reviewer's ${reply} ${preposition} the minor one.`;
      expect(read(words)).toEqual({ b: "rejected", m: "accepted" });
      const { sim, id } = disagreeing();
      sim.requestChanges(inboxItem(sim, "disagreement")!.id, "Side with the reviewer.");
      const check = tickUntil(sim, "design");
      sim.requestChanges(check.id, words);
      tickUntil(sim, "design");
      for (const objection of task(sim, id).objections.filter((entry) => task(sim, id).call!.open.includes(entry.id))) {
        expect(objection.status).toBe(objection.blocking ? "rejected" : "accepted");
      }
    }
  });

  it.each([
    ["Reject the blocking point and tell users what changed.", { b: "rejected" }],
    ["Accept the minor one and confirm the step.", { m: "accepted" }],
    ["Accept the minor one and the step slows everyone.", { m: "accepted" }],
    ["Reject the blocking point and shorten the note.", { b: "rejected" }],
    ["Reject the blocking point and change the note.", { b: "rejected" }],
  ] as const)("keeps a joined remark from deciding an unrelated point: %s", (words, expected) => {
    expect(read(words)).toEqual(expected);
    const decisions = new Map(Object.entries(expected));
    const { sim, id } = disagreeing();
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    let check = tickUntil(sim, "design");
    const due = task(sim, id).call!.open;
    for (const objection of task(sim, id).objections.filter((entry) => due.includes(entry.id))) {
      const decision = decisions.get(objection.blocking ? "b" : "m");
      expect(objection.status).toBe(decision ?? (objection.blocking ? "accepted" : "rejected"));
      expect(objection.call).toBe(decision ? words : undefined);
    }
    sim.requestChanges(check.id, "Accept the blocking point and reject the minor one.");
    check = tickUntil(sim, "design");
    sim.requestChanges(check.id, words);
    tickUntil(sim, "design");
    for (const objection of task(sim, id).objections.filter((entry) => due.includes(entry.id))) {
      const decision = decisions.get(objection.blocking ? "b" : "m");
      expect(objection.status).toBe(decision ?? (objection.blocking ? "accepted" : "rejected"));
      expect(objection.call).toBe(decision ? words : undefined);
    }
  });

  it("keeps a follow-up note from adding the original call's badge to an undecided point", () => {
    const { sim, id } = disagreeing();
    const words = "Reject the blocking point.";
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    let check = tickUntil(sim, "design");
    const due = task(sim, id).call!.open;
    for (const [note, status] of [["Accept the short note.", "accepted"], ["Reject the short note.", "rejected"], ["Accept the short note.", "accepted"], ["Say how it looks on phones.", "accepted"]]) {
      sim.requestChanges(check.id, note!);
      check = tickUntil(sim, "design");
      for (const objection of task(sim, id).objections.filter((entry) => due.includes(entry.id))) {
        expect(objection.status).toBe(objection.blocking ? "rejected" : status);
        expect(objection.call).toBe(objection.blocking ? words : undefined);
      }
      expect(check.body).toContain("Your call settled 1 objection (0 accepted, 1 rejected). The architect answered 1 on its own.");
    }
  });

  it("settles the design: the architect follows it once, no review round, then a design check", () => {
    const { sim, id } = disagreeing();
    const before = task(sim, id);
    const open = before.objections.filter((objection) => objection.status === "open");
    expect(open.length).toBeGreaterThan(1);
    const stage = before.plan!.stages[before.stageIndex]!;
    const rounds = before.rounds[stage.id];
    const reviews = reviewerRuns(before);

    sim.requestChanges(inboxItem(sim, "disagreement")!.id, CALL);
    expect(task(sim, id).call?.text).toBe(CALL);
    sim.tick();
    expect(task(sim, id).agent?.roleId).toBe("architect");
    expect(task(sim, id).todo).toBe("Reading your call");
    sim.tick();
    expect(task(sim, id).statusLine).toBe("Reading the brief");
    expect(task(sim, id).todo).toBe("Reading your call");

    const check = tickUntil(sim, "design");
    const after = task(sim, id);
    expect(inboxItem(sim, "disagreement")).toBeUndefined();
    expect(reviewerRuns(after)).toBe(reviews);
    expect(after.rounds[stage.id]).toBe(rounds);
    expect(after.statusLine).toBe(CALL_WORDS.waiting);
    // Every objection that was open has an answer; the blocking one as the call says, the other in the architect's own name.
    for (const objection of open) {
      const answered = after.objections.find((entry) => entry.id === objection.id)!;
      expect(answered.status).not.toBe("open");
      expect(answered.answer).toBeTruthy();
      expect(answered.call).toBe(objection.blocking ? CALL : undefined);
    }
    expect(after.objections.some((objection) => objection.status === "open")).toBe(false);
    expect(check.body).toContain("Your call settled 1 objection (1 accepted, 0 rejected). The architect answered 1 on its own.");
    const texts = after.timeline.map((entry) => entry.text);
    const made = texts.indexOf(CALL_WORDS.made(CALL));
    expect(made).toBeGreaterThanOrEqual(0);
    expect(texts.indexOf(CALL_WORDS.updated)).toBeGreaterThan(made);
    expect(texts.indexOf(CALL_WORDS.settled)).toBeGreaterThan(texts.indexOf(CALL_WORDS.updated));
    expect(texts.some((text) => text.startsWith("You asked for changes"))).toBe(false);

    // Approving moves on to the build. The call stays, so nothing later can reopen the design it settled.
    sim.approve(check.id);
    sim.tick();
    expect(task(sim, id).call?.text).toBe(CALL);
    expect(task(sim, id).agent?.roleId).toBe("builder");
  });

  it("sends changes asked for at the check after a call to the architect only, back to the same check", () => {
    const { sim, id } = disagreeing();
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, CALL);
    const check = tickUntil(sim, "design");
    const before = task(sim, id);
    const reviews = reviewerRuns(before);
    const rounds = { ...before.rounds };

    sim.requestChanges(check.id, "Say what the confirmation step looks like on phones.");
    const again = tickUntil(sim, "design");
    const after = task(sim, id);
    expect(again.id).not.toBe(check.id);
    expect(after.stageIndex).toBe(before.stageIndex);
    expect(reviewerRuns(after)).toBe(reviews);
    expect(after.rounds).toEqual(rounds);
    expect(inboxItem(sim, "disagreement")).toBeUndefined();
    expect(after.timeline.some((entry) => entry.text === CALL_WORDS.revised)).toBe(true);
    // The architect answered every objection the call covered again, so its notes follow the updated brief.
    for (const objection of after.objections.filter((entry) => after.call!.open.includes(entry.id))) {
      expect(objection.status).not.toBe("open");
      expect(objection.answer).toContain("your note");
    }
  });

  it.each([
    "Reject the reviewer's blocking point: the confirmation step stays.",
    "Reject: the blocking point.",
    "Reject (the blocking point).",
    "Regarding the blocking point, reject it.",
  ])("follows a call that rejects the blocking point, tagging only what it decided: %s", (words) => {
    const { sim, id } = disagreeing();
    const open = task(sim, id).objections.filter((objection) => objection.status === "open");
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    const check = tickUntil(sim, "design");
    const after = task(sim, id);
    for (const objection of open) {
      const answered = after.objections.find((entry) => entry.id === objection.id)!;
      expect(answered.status).toBe("rejected");
      // The call decided the blocking point; the other one the architect answered in its own name.
      expect(answered.call).toBe(objection.blocking ? words : undefined);
    }
    expect(check.body).toContain("Your call settled 1 objection (0 accepted, 1 rejected). The architect answered 1 on its own.");
  });

  it("lets a note at the check correct how the architect read the call", () => {
    const { sim, id } = disagreeing();
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, CALL);
    const check = tickUntil(sim, "design");
    const blocking = task(sim, id).objections.find((objection) => objection.blocking && task(sim, id).call!.open.includes(objection.id))!;
    expect(blocking).toMatchObject({ status: "accepted", call: CALL });
    expect(task(sim, id).journey?.find((step) => step.waitsFor === "call")).toMatchObject({ outcome: W.madeCall, reason: W.yourCall, endedAt: expect.any(Number) });
    const designCheck = task(sim, id).journey!.at(-1)!;

    sim.requestChanges(check.id, "You read my call wrong: keeping the step means I reject the blocking point.");
    const again = tickUntil(sim, "design");
    const journey = task(sim, id).journey!;
    expect(journey.find((step) => step.id === designCheck.id)).toMatchObject({ outcome: W.changes, reason: W.changesAsked, endedAt: expect.any(Number) });
    expect(journey.at(-1)).toMatchObject({ kind: "you", waitsFor: "design" });
    expect(journey.at(-1)?.endedAt).toBeUndefined();
    const corrected = task(sim, id).objections.find((objection) => objection.id === blocking.id)!;
    expect(corrected).toMatchObject({ status: "rejected", call: CALL });
    expect(corrected.answer).toContain("your note");
    expect(again.body).toContain("Your call settled 1 objection (0 accepted, 1 rejected). The architect answered 1 on its own.");

    // A later note that decides nothing leaves the corrected decision as it is.
    sim.requestChanges(again.id, "Say what the confirmation step looks like on phones.");
    const later = tickUntil(sim, "design");
    expect(task(sim, id).objections.find((objection) => objection.id === blocking.id)).toMatchObject({ status: "rejected", call: CALL });

    // A correction can start with "never".
    sim.requestChanges(later.id, "Never reject the blocking point.");
    tickUntil(sim, "design");
    expect(task(sim, id).objections.find((objection) => objection.id === blocking.id)).toMatchObject({ status: "accepted", call: CALL });
  });

  it.each([
    "Reject: the blocking point.",
    "Reject (the blocking point).",
    "Regarding the blocking point, reject it.",
    "Side with the reviewer on the minor point and the architect on the blocking one.",
    "Side with the reviewer on the minor point and the architect for the blocking one.",
    "Side with the reviewer on the minor point and the architect about the blocking one.",
    "Accept the minor point and the architect's answer on the blocking one.",
    "Accept the blocking point. On second thought, reject it.",
  ])("can correct the blocking decision at the design check: %s", (note) => {
    const { sim, id } = disagreeing();
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, CALL);
    const check = tickUntil(sim, "design");
    const before = task(sim, id);
    const blocking = before.objections.find((objection) => objection.blocking && before.call!.open.includes(objection.id))!;
    expect(blocking.status).toBe("accepted");

    sim.requestChanges(check.id, note);
    tickUntil(sim, "design");
    const after = task(sim, id);
    expect(after.objections.find((objection) => objection.id === blocking.id)).toMatchObject({ status: "rejected", call: CALL });
    expect(reviewerRuns(after)).toBe(reviewerRuns(before));
    expect(after.rounds).toEqual(before.rounds);
  });

  it.each([
    "Side with the reviewer on the minor point and the architect on the blocking one.",
    "Side with the reviewer on the minor point and the architect for the blocking one.",
    "Side with the reviewer on the minor point and the architect about the blocking one.",
    "Side with the reviewer for the minor point and the architect about the blocking one.",
    "Accept the minor point and the architect's answer on the blocking one.",
  ])("follows both parts of a split call: %s", (words) => {
    const { sim, id } = disagreeing();
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    tickUntil(sim, "design");
    const after = task(sim, id);
    for (const objection of after.objections.filter((entry) => after.call!.open.includes(entry.id))) {
      expect(objection.status).toBe(objection.blocking ? "rejected" : "accepted");
      expect(objection.call).toBe(words);
    }
  });

  it("leaves an unclear later reference to the architect, without a 'Your call' tag", () => {
    const { sim, id } = disagreeing();
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, "Reject both points. On second thought, accept it.");
    const check = tickUntil(sim, "design");
    const after = task(sim, id);
    for (const objection of after.objections.filter((entry) => after.call!.open.includes(entry.id))) {
      expect(objection.status).toBe(objection.blocking ? "accepted" : "rejected");
      expect(objection.call).toBeUndefined();
    }
    expect(check.body).toContain("Your call settled 0 objections (0 accepted, 0 rejected). The architect answered 2 on its own.");
  });

  it("keeps the call's decisions and tags when a note at the check only accepts the brief", () => {
    const { sim, id } = disagreeing();
    const words = "Reject the blocking point.";
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    const check = tickUntil(sim, "design");
    const before = task(sim, id).objections.filter((objection) => task(sim, id).call!.open.includes(objection.id));

    sim.requestChanges(check.id, "I accept the brief, just say what the step looks like on phones.");
    const again = tickUntil(sim, "design");
    for (const objection of before) {
      const after = task(sim, id).objections.find((entry) => entry.id === objection.id)!;
      expect(after.status).toBe("rejected");
      expect(after.call).toBe(objection.blocking ? words : undefined);
    }
    expect(again.body).toContain("Your call settled 1 objection (0 accepted, 1 rejected). The architect answered 1 on its own.");
  });

  it("answers in the architect's own name when it cannot read a decision in the call", () => {
    const { sim, id } = disagreeing();
    const words = "Keep the confirmation step, but only for existing accounts.";
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    const check = tickUntil(sim, "design");
    const after = task(sim, id);
    for (const objection of after.objections.filter((entry) => after.call!.open.includes(entry.id))) {
      expect(objection.status).toBe(objection.blocking ? "accepted" : "rejected");
      expect(objection.call).toBeUndefined();
    }
    expect(check.body).toContain("Your call settled 0 objections (0 accepted, 0 rejected). The architect answered 2 on its own.");
  });

  it("decides only the point a call names, even when the call names the feature", () => {
    const { sim, id } = disagreeing();
    const words = "Reject the minor suggestion for saved carts.";
    sim.requestChanges(inboxItem(sim, "disagreement")!.id, words);
    const check = tickUntil(sim, "design");
    const after = task(sim, id);
    for (const objection of after.objections.filter((entry) => after.call!.open.includes(entry.id))) {
      expect(objection.status).toBe(objection.blocking ? "accepted" : "rejected");
      expect(objection.call).toBe(objection.blocking ? undefined : words);
    }
    expect(check.body).toContain("Your call settled 1 objection (0 accepted, 1 rejected). The architect answered 1 on its own.");
  });

  it("answers the plan's own design check after Screens: no second check, and approving it keeps the call", () => {
    const { sim, id } = disagreeing("new");
    const before = task(sim, id);
    const design = before.plan!.stages[before.stageIndex]!;
    const stages = before.plan!.stages.map((stage) => stage.id);
    expect(before.plan!.stages[before.stageIndex + 1]!.roleId).toBe("ux-designer");
    const reviews = reviewerRuns(before);
    const rounds = { ...before.rounds };

    sim.requestChanges(inboxItem(sim, "disagreement")!.id, CALL);
    expect(task(sim, id).plan!.stages.map((stage) => stage.id)).toEqual(stages);
    const check = tickUntil(sim, "design");
    const at = task(sim, id);
    // Screens ran after the architect followed the call, and the check is the plan's own, with the call's words.
    expect(at.plan!.stages[at.stageIndex]).toMatchObject({ kind: "gate", gate: "design" });
    expect(at.plan!.stages[at.stageIndex]!.id).not.toBe(`${design.id}:call-check`);
    expect(at.timeline.findIndex((entry) => entry.roleId === "ux-designer")).toBeGreaterThan(at.timeline.findIndex((entry) => entry.text === CALL_WORDS.settled));
    expect(at.statusLine).toBe(CALL_WORDS.waiting);
    expect(check.body).toContain("Your call settled 1 objection (1 accepted, 0 rejected). The architect answered 1 on its own.");

    // Changes there go to the architect alone and come back, through Screens, to the same check.
    sim.requestChanges(check.id, "Say what the confirmation step looks like on phones.");
    const again = tickUntil(sim, "design");
    const after = task(sim, id);
    expect(after.stageIndex).toBe(at.stageIndex);
    expect(after.plan!.stages.map((stage) => stage.id)).toEqual(stages);
    expect(reviewerRuns(after)).toBe(reviews);
    expect(after.rounds).toEqual(rounds);
    expect(inboxItem(sim, "disagreement")).toBeUndefined();
    expect(after.statusLine).toBe(CALL_WORDS.waiting);
    expect(again.body).toContain("Your call settled");

    // Approving it moves on to the build, and the call stays.
    sim.approve(again.id);
    sim.tick();
    expect(task(sim, id).call?.text).toBe(CALL);
    expect(task(sim, id).agent?.roleId).toBe("builder");
    expect(task(sim, id).plan!.stages.filter((stage) => stage.kind === "gate" && stage.gate === "design")).toHaveLength(1);
  });

  it("adds a design check after a call when the plan has none before the build, and moves on from it", () => {
    const seed = disagreeing();
    const id = seed.id;
    const sim = reshaped(seed.sim, id, (stages) => stages.filter((stage) => !(stage.kind === "gate" && stage.gate === "design")));
    const design = task(sim, id).plan!.stages[task(sim, id).stageIndex]!;
    expect(task(sim, id).plan!.stages[task(sim, id).stageIndex + 1]!.roleId).toBe("builder");

    sim.requestChanges(inboxItem(sim, "disagreement")!.id, CALL);
    const check = tickUntil(sim, "design");
    const at = task(sim, id);
    expect(at.plan!.stages[at.stageIndex]).toMatchObject({ kind: "gate", gate: "design", id: `${design.id}:call-check` });
    expect(at.plan!.stages[at.stageIndex - 1]!.id).toBe(design.id);
    expect(check.body).toContain("Your call settled");

    sim.approve(check.id);
    sim.tick();
    expect(task(sim, id).agent?.roleId).toBe("builder");
  });

  it("never lets a later design check reopen the design the call settled", () => {
    const seed = disagreeing();
    const id = seed.id;
    // Design, its check, Screens, then a second design check on the same design.
    const sim = reshaped(seed.sim, id, (stages, design) => {
      const screens: Stage = { id: `${stages[design]!.id}:ux`, kind: "do", title: "Screens", roleId: "ux-designer", profileIds: ["opus-high"] };
      const later: Stage = { id: `${stages[design]!.id}:later-check`, kind: "gate", title: "Your design check", roleId: "architect", profileIds: [], gate: "design" };
      return [...stages.slice(0, design + 2), screens, later, ...stages.slice(design + 2)];
    });
    const before = task(sim, id);
    const reviews = reviewerRuns(before);
    const rounds = { ...before.rounds };
    const stages = before.plan!.stages.length;

    sim.requestChanges(inboxItem(sim, "disagreement")!.id, CALL);
    sim.approve(tickUntil(sim, "design").id);
    const later = tickUntil(sim, "design");
    expect(task(sim, id).plan!.stages[task(sim, id).stageIndex]!.id).toContain(":later-check");
    expect(task(sim, id).statusLine).toBe(CALL_WORDS.waiting);
    expect(later.body).toContain("Your call settled");

    // Changes at the later check go to the architect alone: no review round, no new disagreement.
    sim.requestChanges(later.id, "Say what the confirmation step looks like on phones.");
    const checks: string[] = [];
    for (let tick = 0; tick < 300 && task(sim, id).agent?.roleId !== "builder"; tick += 1) {
      sim.tick();
      for (const item of sim.getState().inbox.filter((entry) => entry.taskId === id)) {
        expect(item.kind).toBe("design");
        expect(item.body).toContain("Your call settled");
        checks.push(item.id);
        sim.approve(item.id);
      }
    }
    const after = task(sim, id);
    expect(after.agent?.roleId).toBe("builder");
    expect(checks.length).toBeGreaterThan(0);
    expect(reviewerRuns(after)).toBe(reviews);
    expect(after.rounds).toEqual(rounds);
    expect(after.plan!.stages).toHaveLength(stages);
    expect(after.timeline.some((entry) => entry.text === CALL_WORDS.revised)).toBe(true);
    expect(after.objections.some((objection) => objection.status === "open")).toBe(false);
  });

  it("leaves siding with the architect as it was", () => {
    const { sim, id } = disagreeing();
    const before = task(sim, id);
    const open = before.objections.filter((objection) => objection.status === "open").map((objection) => objection.id);
    const stages = before.plan!.stages.length;

    sim.approve(inboxItem(sim, "disagreement")!.id);
    const after = task(sim, id);
    expect(after.timeline.at(-1)?.text).toBe("You sided with the architect");
    for (const objectionId of open) {
      const objection = after.objections.find((entry) => entry.id === objectionId)!;
      expect(objection.status).toBe("rejected");
      expect(objection.call).toBeUndefined();
    }
    expect(after.call).toBeUndefined();
    expect(after.plan!.stages).toHaveLength(stages);
    expect(inboxItem(sim, "design")?.body).toBeUndefined();
  });

  it("sends the design back for a full round when changes are asked for at a check with no call", () => {
    const sim = new Simulator(emptyState(), { prMergeAfter: 1_000 });
    const id = sim.addTask({ productId: "p", title: "Saved carts", kind: "feature" });
    const check = tickUntil(sim, "design");
    const before = task(sim, id);
    const reviews = reviewerRuns(before);

    sim.requestChanges(check.id, "Keep carts for a month.");
    tickUntil(sim, "design");
    const after = task(sim, id);
    expect(reviewerRuns(after)).toBe(reviews + 1);
    expect(after.timeline.some((entry) => entry.text === "You asked for changes: Keep carts for a month.")).toBe(true);
  });
});
