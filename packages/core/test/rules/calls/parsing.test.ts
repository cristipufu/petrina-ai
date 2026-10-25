import { describe, expect, it } from "vitest";

import { answerByCall, dueAnswers, unanswered } from "../../../src/call.js";

import type { DesignCall, Objection } from "../../../src/model.js";

import { readCall } from "../../../src/sim-script.js";

describe("The coordinator's call on a design disagreement", () => {
  const CALL = "Accept the blocking point: keep the confirmation step only for existing accounts.";

  const objections = [
    { id: "b", blocking: true, text: "The answer for existing accounts adds a confirmation step to notifications that slows everyone down." },
    { id: "m", blocking: false, text: "Consider a short note telling existing users what changed." },
  ];

  const read = (words: string) => Object.fromEntries(readCall(words, objections, "notifications"));

  it("keeps negatives, conditions and unclear wording around emphasis or a detached point unclear", () => {
    for (const words of [
      "Accept neither point in any case.",
      "Accept none of them without exception.",
      "Reject any point in any case.",
      "I do not want to reject the blocking point in any case.",
      "Should we reject the blocking point in any case?",
      "Reject the blocking point if the note stays, in any case.",
      "Reject the blocking point in any case where the note stays.",
      "Accept both without exception except the short note.",
      "Reject the blocking point, whether the note stays.",
      "Reject the blocking point, whether or not we accept the minor one.",
      "Accept it: the short note or the blocking point.",
      "Reject — if the minor point stays.",
      "I accept the brief — the blocking point.",
      "Reject the blocking point, while the note stays.",
      "While it stays, reject the blocking point.",
      "Reject the blocking point while the confirmation step stays.",
      "While the step stays, reject the blocking point.",
    ]) expect(read(words), words).toEqual({});
    expect(read("Reject the blocking point, in any case.")).toEqual({ b: "rejected" });
    expect(read("Accept the short note, whether or not the blocking point stays.")).toEqual({ m: "accepted" });
    expect(read("Never reject the blocking point in any case.")).toEqual({ b: "accepted" });
    expect(read("I refuse to accept it: the blocking point.")).toEqual({ b: "rejected" });
  });

  it("keeps later decisions and named points ahead of an earlier pronoun's topic", () => {
    expect(read("Reject the blocking point in any case. On second thought, accept it.")).toEqual({ b: "accepted" });
    expect(read("Reject it: the blocking point. On second thought, accept it.")).toEqual({ b: "accepted" });
    expect(read("Accept the minor point. Reject it: the blocking point.")).toEqual({ b: "rejected", m: "accepted" });
    expect(read("Reject the blocking point. Accept it: the short note.")).toEqual({ b: "rejected", m: "accepted" });
    expect(read("Accept – the short note.")).toEqual({ m: "accepted" });
    expect(read("Reject - the blocking point.")).toEqual({ b: "rejected" });
  });

  it("withdraws an earlier alternative without changing an unrelated decision", () => {
    expect(read("Accept the minor point. Reject the blocking point. Or accept it.")).toEqual({ m: "accepted" });
    expect(read("Reject the blocking point. Or accept the minor point. Reject both points.")).toEqual({ b: "rejected", m: "rejected" });
    expect(read("Reject the blocking point in any case, or accept the short note.")).toEqual({});
    expect(read("Accept both without exception except the short note.")).toEqual({});
    expect(read("Accept the blocking point and the short note, but reject the short note.")).toEqual({});
    expect(read("Accept the minor point. Reject the blocking point. Alternatively, accept it.")).toEqual({ m: "accepted" });
    expect(read("Reject the blocking point. Alternatively, accept the short note. Reject both points.")).toEqual({ b: "rejected", m: "rejected" });
  });

  it("reads accept, reject and siding with either side, per objection the words name", () => {
    expect(read("Keep the confirmation step, but only for existing accounts.")).toEqual({});
    expect(read("Side with the reviewer.")).toEqual({ b: "accepted", m: "accepted" });
    expect(read("I side with the architect on this.")).toEqual({ b: "rejected", m: "rejected" });
    expect(read("Reject the blocking point but accept the minor one.")).toEqual({ b: "rejected", m: "accepted" });
    expect(read("Accept the not blocking point.")).toEqual({ m: "accepted" });
    expect(read("Accept the architect's answer on the confirmation step.")).toEqual({ b: "rejected" });
    expect(read("Don't reject the point about telling users.")).toEqual({ m: "accepted" });
    expect(read("Reject it all. Actually, accept the blocking one.")).toEqual({ b: "accepted", m: "rejected" });
    // Short words name a point too, and the feature's name names none.
    expect(read("Reject the short note.")).toEqual({ m: "rejected" });
    expect(read("Reject the minor suggestion for notifications.")).toEqual({ m: "rejected" });
    expect(read("Accept the minor point about notifications.")).toEqual({ m: "accepted" });
    expect(read("Accept the point about notifications.")).toEqual({});
    // Opposite decisions in one sentence stay apart, wherever the points sit.
    expect(read("The minor one I reject, the blocking point I accept.")).toEqual({ b: "accepted", m: "rejected" });
    expect(read("Accept the blocking point, not the minor one.")).toEqual({ b: "accepted", m: "rejected" });
    expect(read("Accept everything except the short note.")).toEqual({ b: "accepted", m: "rejected" });
    expect(read("Side with the reviewer on the blocking point but with the architect on the minor one.")).toEqual({ b: "accepted", m: "rejected" });
    expect(read("Reject the minor one and accept the rest.")).toEqual({ b: "accepted", m: "rejected" });
    // A list adds to a decision, a clause before it says what it is about, and one after it only explains.
    expect(read("Accept the blocking point and the short note.")).toEqual({ b: "accepted", m: "accepted" });
    expect(read("Accept the blocking point and the notes about what changed.")).toEqual({ b: "accepted", m: "accepted" });
    expect(read("Reject the note about what changed.")).toEqual({ m: "rejected" });
    expect(read("Accept the blocking point except the note about what changed.")).toEqual({ b: "accepted", m: "rejected" });
    expect(read("Accept the blocking point and the note about everyone.")).toEqual({ b: "accepted" });
    expect(read("Either way, reject the blocking point and accept the short note.")).toEqual({ b: "rejected", m: "accepted" });
    expect(read("Reject the blocking point in any case, while accepting the short note.")).toEqual({ b: "rejected", m: "accepted" });
    expect(read("Reject the blocking point and the architect to review the minor one.")).toEqual({ b: "rejected" });
    expect(read("Don't reject the blocking point, while accepting the short note.")).toEqual({ b: "accepted", m: "accepted" });
    expect(read("For the blocking point, side with the architect.")).toEqual({ b: "rejected" });
    expect(read("Reject the blocking point, users hate extra steps.")).toEqual({ b: "rejected" });
    // An "and" part that is more than a name only explains.
    expect(read("Accept the minor one and keep the confirmation step.")).toEqual({ m: "accepted" });
    expect(read("Reject the blocking point and keep the note short.")).toEqual({ b: "rejected" });
    expect(read("Accept the blocking point and the rest.")).toEqual({ b: "accepted", m: "accepted" });
    // "All but" and "everything but" leave a point out.
    expect(read("Accept all but the blocking point.")).toEqual({ b: "rejected", m: "accepted" });
    expect(read("Reject everything but the short note.")).toEqual({ b: "rejected", m: "accepted" });
    // "Never", "not" or "refuse to" just before a decision turn it round.
    expect(read("Never accept the blocking point.")).toEqual({ b: "rejected" });
    expect(read("Reject the minor one, never accept the blocking point.")).toEqual({ b: "rejected", m: "rejected" });
    expect(read("Never mind, reject the blocking point.")).toEqual({ b: "rejected" });
    expect(read("I refuse to accept the blocking point.")).toEqual({ b: "rejected" });
    expect(read("I won't accept the blocking point.")).toEqual({ b: "rejected" });
    // Anything unclear decides nothing.
    for (const words of [
      "I accept the brief, just say what the step looks like on phones.",
      "Fine, I accept that.",
      "Accept neither point.",
      "Accept none of them.",
      "Reject none of the points.",
      "Accept one of them.",
      "I do not want to accept the minor one.",
      "Should we accept the blocking point?",
      "Accept the blocking point or the minor one.",
      "Accept the blocking point if the step is optional.",
      "Accept the short note about the confirmation step.",
      "Side with the reviewer and side with the architect.",
      "I disagree with the reviewer.",
      "I agree with the architect.",
      "The architect is right.",
    ]) {
      expect(read(words)).toEqual({});
    }
  });

  it("keeps a decision with its point across punctuation or an introductory phrase", () => {
    expect(read("Reject: the blocking point.")).toEqual({ b: "rejected" });
    expect(read("Reject (the blocking point).")).toEqual({ b: "rejected" });
    expect(read("Regarding the blocking point, reject it.")).toEqual({ b: "rejected" });
    expect(read("Regarding the minor point, accept it.")).toEqual({ m: "accepted" });
    // Explanations still cannot add another point to a decision.
    expect(read("Reject the minor point: keep the confirmation step.")).toEqual({ m: "rejected" });
    expect(read("I accept the brief, the blocking point still needs an answer.")).toEqual({});
    expect(read("Accept: the minor point, reject: the blocking one.")).toEqual({ b: "rejected", m: "accepted" });
  });

  it("keeps each side with the point it names in a split call", () => {
    expect(read("Side with the reviewer on the minor point and the architect on the blocking one.")).toEqual({ b: "rejected", m: "accepted" });
    expect(read("Accept the minor point and the architect's answer on the blocking one.")).toEqual({ b: "rejected", m: "accepted" });
    expect(read("Side with the architect on the minor point and the reviewer on the blocking one.")).toEqual({ b: "accepted", m: "rejected" });
    expect(read("Reject the minor point and the architect's answer on the blocking one.")).toEqual({ b: "accepted", m: "rejected" });
    expect(read("Accept the minor point and the architect will explain the blocking one.")).toEqual({ m: "accepted" });
  });

  it("lets a later sentence change the last point's decision, leaving an unclear reference to the architect", () => {
    expect(read("Accept the blocking point. On second thought, reject it.")).toEqual({ b: "rejected" });
    expect(read("Reject the blocking point. Never mind, accept it.")).toEqual({ b: "accepted" });
    expect(read("Accept the minor point. Reject the blocking point. Never mind, accept it.")).toEqual({ b: "accepted", m: "accepted" });
    expect(read("Accept both points. On second thought, reject it.")).toEqual({});
    expect(read("Accept the blocking point. Should we accept the minor one? Reject it.")).toEqual({});
    expect(read("Accept the blocking point. I have doubts about the short note, reject it.")).toEqual({});
    expect(read("Reject it.")).toEqual({});
    expect(read("Accept the blocking point. Fine, I accept that.")).toEqual({ b: "accepted" });
  });

  it("lets the architect correct a decision, a 'Your call' tag or a note when changes are asked for after a call", () => {
    const call: DesignCall = { text: CALL, stageId: "design", open: ["a", "b"], at: 0 };
    const objection = (id: string, extra: Partial<Objection>): Objection => ({ id, round: 2, text: `Objection ${id}`, blocking: true, raisedBy: "sol-xhigh", status: "open", ...extra });
    const answered = [
      objection("a", { status: "rejected", answer: "Removed it, as the call says.", call: CALL }),
      objection("b", { status: "accepted", answer: "Added it." }),
      objection("c", { status: "accepted", answer: "Settled before the call." }),
    ];
    // Every objection the call covered is due again; one answered before the call is not.
    expect(dueAnswers(answered, call).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(unanswered(answered, call, [{ id: "a" }]).map((entry) => entry.id)).toEqual(["b"]);

    const corrected = answerByCall(answered, call, [
      { id: "a", status: "accepted", byCall: false, answer: "The call does not decide it. Kept it in the brief." },
      { id: "b", status: "rejected", byCall: true, answer: "Left it out of the brief, as the call says." },
      { id: "c", status: "rejected", byCall: true, answer: "Not due." },
    ]);
    expect(corrected[0]).toEqual(objection("a", { status: "accepted", answer: "The call does not decide it. Kept it in the brief." }));
    expect(corrected[1]).toEqual(objection("b", { status: "rejected", answer: "Left it out of the brief, as the call says.", call: CALL }));
    expect(corrected[2]).toBe(answered[2]);
  });
});
