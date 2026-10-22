import { describe, expect, it, vi } from "vitest";
import { createDemo, createPortfolioDemo } from "../src/demo.js";
import { followUpBlock, followUpKey, followUpSnapshot, noteReviewTag, planFollowUps, type FollowUpCandidate, type FollowUpSnapshot, type MatchAnswer, type MatchAsk, type OpenFollowUp } from "../src/follow-ups.js";

function report(partial: Partial<FollowUpCandidate> & Pick<FollowUpCandidate, "taskId" | "findingId" | "text">): FollowUpCandidate {
  return {
    sourceTitle: partial.sourceTitle ?? partial.taskId,
    steps: partial.steps ?? "Open the page and use the old control.",
    evidence: partial.evidence ?? "The same control failed on the previous version.",
    raisedBy: partial.raisedBy ?? "opus-high",
    productIds: partial.productIds ?? ["shop"],
    at: partial.at ?? 1,
    images: partial.images ?? [],
    sourceDone: partial.sourceDone ?? true,
    ...partial,
    key: followUpKey(partial.taskId, partial.findingId),
  };
}

function card(partial: Partial<OpenFollowUp> & Pick<OpenFollowUp, "id">): OpenFollowUp {
  return { phase: "backlog", productIds: ["shop"], title: partial.id, problem: partial.id, reportKeys: [], ...partial };
}

function snap(reports: FollowUpCandidate[], extra: Partial<FollowUpSnapshot> = {}): FollowUpSnapshot {
  return { reports, cards: extra.cards ?? [], pending: extra.pending ?? [], keptImages: extra.keptImages ?? [] };
}

async function plan(snapshot: FollowUpSnapshot, answer: MatchAnswer | ((asked: readonly string[]) => MatchAnswer) = { groups: [], uncertain: [] }) {
  const asked: string[][] = [];
  const result = await planFollowUps(snapshot, (ask) => {
    asked.push(ask.reports.map((report) => report.key));
    return typeof answer === "function" ? answer(ask.reports.map((report) => report.key)) : answer;
  });
  return { ...result, asked };
}

describe("confirmed older bugs", async () => {
  it("shows a card's current request rather than an immutable obsolete report", () => {
    const original = createDemo(1_000_000_000).state.tasks[0]!;
    const task = JSON.parse(JSON.stringify(original)) as typeof original;
    Object.assign(task, { state: "backlog", kind: "bug", title: "Current remaining defect", description: "The coordinator's current reproduction", followUp: { reports: [{ taskId: "source", findingId: "old", text: "The already repaired original defect", productIds: [task.productId] }] } });
    const snapshot = followUpSnapshot([task]);
    expect(snapshot.cards[0]?.problem).toBe("The coordinator's current reproduction");
    expect(snapshot.cards[0]?.reportKeys).toEqual(["source::old"]);
  });

  it("does not link a fixed-scope manual bug to a report for a different product set", async () => {
    const manual = card({ id: "manual", fixedProducts: true, productIds: ["shop"] });
    const multi = report({ taskId: "source", findingId: "both", text: "A distinct shared bug", productIds: ["shop", "notes"] });
    const result = await plan(snap([multi], { cards: [manual] }), { groups: [{ keys: [multi.key], cardId: manual.id }] });
    expect(result.linked).toEqual([]);
    expect(result.created).toHaveLength(1);
  });
  it("opens one backlog card for one confirmed report and skips nits, checks and unfinished work", async () => {
    expect(followUpBlock({ text: "Old", status: "open", severity: "pre-existing", raisedBy: "opus-high", steps: "Look", evidence: "It was already wrong." })).toBeUndefined();
    expect(followUpBlock({ text: "Old", status: "open", severity: "pre-existing", raisedBy: "opus-high", evidence: "It was already wrong." })).toBe("missing-steps");
    expect(followUpBlock({ text: "Old", status: "open", severity: "pre-existing", raisedBy: "opus-high", steps: "Look" })).toBe("missing-evidence");
    expect(followUpBlock({ text: "Old", status: "open", severity: "pre-existing", raisedBy: "opus-high", steps: "Look", verification: { by: "sol", verdict: "pre-existing", reason: "The previous version already failed.", at: 1 } })).toBeUndefined();
    expect(followUpBlock({ text: "Nit", status: "open", severity: "suggestion", raisedBy: "opus-high", steps: "Look", evidence: "Small." })).toBe("skip");
    expect(followUpBlock({ text: "Broken", status: "open", severity: "blocking", raisedBy: "opus-high", steps: "Look", evidence: "Now." })).toBe("skip");
    expect(followUpBlock({ text: "Gone", status: "dismissed", severity: "pre-existing", raisedBy: "opus-high", steps: "Look", evidence: "Old." })).toBe("skip");
    expect(followUpBlock({ text: "Check failed: tests", status: "open", severity: "pre-existing", raisedBy: "petrina", steps: "Look", evidence: "Old." })).toBe("skip");
    expect(followUpBlock({ text: "Failed acceptance check: the page", status: "open", severity: "pre-existing", raisedBy: "opus-high", steps: "Look", evidence: "Old." })).toBe("skip");

    const ready = report({ taskId: "done", findingId: "old", text: "The footer link opens a retired page." });
    const thin = report({ taskId: "done", findingId: "thin", text: "No steps", steps: undefined, block: "missing-steps" });
    const running = report({ taskId: "open", findingId: "later", text: "Saved, but the task is not done.", sourceDone: false });
    const { created, tracks, asked } = await plan(snap([ready, thin]));
    expect(asked).toEqual([]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ productIds: ["shop"], keys: [ready.key] });
    expect(created[0]!.description).toContain("How to see it again");
    expect(created[0]!.description).toContain("Why the change left it as it was");
    expect(created[0]!.reports[0]).toMatchObject({ raisedBy: "opus-high", sourceTitle: "done" });
    expect(tracks).toEqual([{ taskId: "done", findingId: "thin", tracking: { reason: "missing-steps" } }]);
    const held = await plan(snap([running]));
    expect(held.asked).toEqual([]);
    expect(held.created).toEqual([]);
    expect(held.tracks).toEqual([]);
  });

  it("puts two differently worded reports on one card, in either order", async () => {
    const first = report({ taskId: "a", findingId: "1", text: "The footer About link opens a retired page." });
    const second = report({ taskId: "a", findingId: "2", text: "Choosing About in the footer still lands on the old page.", raisedBy: "sol-high", roleId: "security-reviewer" });
    const match = vi.fn((keys: readonly string[]) => ({ groups: [{ keys }], uncertain: [] }));
    const together = await plan(snap([first, second]), match);
    expect(match).toHaveBeenCalledOnce();
    expect(together.created).toHaveLength(1);
    expect(together.created[0]!.reports.map((entry) => entry.text)).toEqual([first.text, second.text]);
    expect(together.created[0]!.reports.map((entry) => entry.roleId)).toEqual([undefined, "security-reviewer"]);

    const early = await plan(snap([first, report({ ...second, sourceDone: false })]), match);
    expect(early.created).toHaveLength(1);
    expect(early.created[0]!.keys).toEqual([first.key, second.key]);
    const credited = { ...second, sourceDone: true, tracking: { taskId: "card" } as const };
    const later = await plan(snap([report({ ...first, tracking: { taskId: "card" } }), credited], { cards: [card({ id: "card", reportKeys: [first.key, second.key] })] }));
    expect(later.created).toEqual([]);
    expect(later.asked).toEqual([]);
  });

  it("credits a saved report from the other task whichever one finishes first", async () => {
    const left = report({ taskId: "left", findingId: "1", text: "Search ignores the second word." });
    const right = report({ taskId: "right", findingId: "1", text: "The second search word is dropped.", sourceDone: false });
    const answer = { groups: [{ keys: [left.key, right.key] }], uncertain: [] as string[] };
    const first = await plan(snap([left, right]), answer);
    expect(first.created).toHaveLength(1);
    expect(first.created[0]!.keys).toEqual([left.key, right.key]);

    const reversed = await plan(snap([report({ ...left, sourceDone: false }), report({ ...right, sourceDone: true })]), answer);
    expect(reversed.created).toHaveLength(1);
    expect(reversed.created[0]!.reports.map((entry) => entry.taskId).sort()).toEqual(["left", "right"]);

    const waiting = await plan(snap([left]));
    expect(waiting.created).toHaveLength(1);
    const joined = await plan(snap([
      report({ ...right, sourceDone: true }),
    ], { cards: [card({ id: "card", problem: left.text, reportKeys: [left.key] })] }), { groups: [{ keys: [right.key], cardId: "card" }] });
    expect(joined.created).toEqual([]);
    expect(joined.linked.map((entry) => entry.cardId)).toEqual(["card"]);
  });

  it("does not open a second card when the match is known but the card is not saved yet", async () => {
    const one = report({ taskId: "a", findingId: "1", text: "One wording of the footer bug." });
    const two = report({ taskId: "b", findingId: "1", text: "Another wording of the footer bug." });
    const again = await plan(snap([one, two], { pending: [{ keys: [one.key, two.key] }] }), () => { throw new Error("matcher"); });
    expect(again.asked).toEqual([]);
    expect(again.created).toHaveLength(1);
    expect(again.created[0]!.keys).toEqual([one.key, two.key]);
    const saved = await plan(snap([
      report({ ...one, tracking: { taskId: "card" } }),
      two,
    ], { cards: [card({ id: "card", reportKeys: [one.key] })], pending: [{ keys: [one.key, two.key], cardId: "card" }] }));
    expect(saved.created).toEqual([]);
    expect(saved.linked.map((entry) => entry.keys)).toEqual([[two.key]]);
  });

  it("leaves both reports untracked when the match cannot tell them apart", async () => {
    const one = report({ taskId: "a", findingId: "1", text: "The date is wrong." });
    const two = report({ taskId: "b", findingId: "1", text: "The year is wrong." });
    const lost = await plan(snap([one, two]), { groups: [], uncertain: [one.key, two.key] });
    expect(lost.created).toEqual([]);
    expect(lost.linked).toEqual([]);
    expect(lost.tracks.map((entry) => entry.tracking)).toEqual([{ reason: "unmatched" }, { reason: "unmatched" }]);
  });

  it("keeps a report retryable when matching cannot run, then links it once", async () => {
    const one = report({ taskId: "a", findingId: "1", text: "The date is wrong." });
    const held = await plan(snap([one, report({ taskId: "b", findingId: "1", text: "The year is wrong." })]), "unavailable");
    expect(held.created).toEqual([]);
    expect(held.pending).toEqual([{ keys: [one.key, followUpKey("b", "1")], retry: true }]);
    expect(held.tracks.every((entry) => "reason" in entry.tracking && entry.tracking.reason === "unavailable" && entry.tracking.retry)).toBe(true);
    const retry = await plan(snap([
      report({ ...one, tracking: { reason: "unavailable", retry: true } }),
      report({ taskId: "b", findingId: "1", text: "The year is wrong.", tracking: { reason: "unavailable", retry: true } }),
    ]), { groups: [{ keys: [one.key, followUpKey("b", "1")] }] });
    expect(retry.created).toHaveLength(1);
    expect(retry.pending).toEqual([]);
  });

  it("follows a reviewer's card, keeps a refusal off that card, and leaves a missing choice untracked", async () => {
    const pointed = report({ taskId: "a", findingId: "1", text: "Words that do not match the card.", cardsShown: ["card"], sameBug: "card" });
    const refused = report({ taskId: "b", findingId: "1", text: "A different footer bug.", cardsShown: ["card"], sameBug: "none" });
    const other = report({ taskId: "c", findingId: "1", text: "Another report of that different footer bug.", cardsShown: ["card"], sameBug: "none" });
    const silent = report({ taskId: "d", findingId: "1", text: "Nobody chose.", cardsShown: ["card"] });
    const cards = [card({ id: "card", problem: "The known footer bug" })];
    const chosen = await plan(snap([pointed, refused, other, silent], { cards }), { groups: [{ keys: [refused.key, other.key] }] });
    expect(chosen.asked).toEqual([[refused.key, other.key]]);
    expect(chosen.linked.map((entry) => entry.cardId)).toEqual(["card"]);
    expect(chosen.created).toHaveLength(1);
    expect(chosen.created[0]!.keys).toEqual([refused.key, other.key]);
    expect(chosen.tracks).toContainEqual({ taskId: "d", findingId: "1", tracking: { reason: "no-choice" } });
    expect(chosen.created[0]!.reports.every((entry) => entry.taskId !== "card")).toBe(true);
  });

  it("adds a product while the card waits, and only records one named after work starts", async () => {
    const extra = report({ taskId: "notes", findingId: "1", text: "The same footer bug on Notes.", productIds: ["notes"], cardsShown: ["card"], sameBug: "card" });
    const waiting = await plan(snap([extra], { cards: [card({ id: "card", productIds: ["shop"] })] }));
    expect(waiting.linked[0]).toMatchObject({ addProducts: ["notes"], alsoReported: [] });
    const started = await plan(snap([extra], { cards: [card({ id: "card", phase: "started", productIds: ["shop"] })] }));
    expect(started.linked[0]).toMatchObject({ addProducts: [], alsoReported: ["notes"] });
    const finished = report({ taskId: "again", findingId: "1", text: "The footer bug came back.", cardsShown: ["card"], sameBug: "card" });
    const fresh = await plan(snap([finished], { cards: [card({ id: "card", phase: "closed" })] }));
    expect(fresh.linked).toEqual([]);
    expect(fresh.created).toHaveLength(1);
  });

  it("keeps one copy of a picture and none for a report that stays untracked", async () => {
    const pictured = report({ taskId: "a", findingId: "1", text: "The footer is wrong.", images: [{ caption: "Footer", sourceTaskId: "a", sourceImageId: "pic" }, { caption: "Footer", sourceTaskId: "a", sourceImageId: "pic" }] });
    const second = report({ taskId: "b", findingId: "1", text: "The footer link is wrong.", images: [{ caption: "Footer", sourceTaskId: "a", sourceImageId: "pic" }] });
    const created = await plan(snap([pictured, second]), { groups: [{ keys: [pictured.key, second.key] }] });
    expect(created.created[0]!.reports.flatMap((entry) => entry.images)).toEqual([{ caption: "Footer", sourceTaskId: "a", sourceImageId: "pic" }]);
    const quiet = await plan(snap([pictured, second]), { groups: [], uncertain: [pictured.key, second.key] });
    expect(quiet.created).toEqual([]);
    expect(quiet.tracks.every((entry) => "reason" in entry.tracking && entry.tracking.reason === "unmatched")).toBe(true);
  });

  it("keeps an Important tag and an older tag together until the usual vote", async () => {
    const older = noteReviewTag(undefined, "pre-existing", "opus-high", 1);
    expect(older).toMatchObject({ severity: "pre-existing", clearVote: false });
    const caused = noteReviewTag(older, "blocking", "sol-high", 2);
    expect(caused.severity).toBe("blocking");
    expect(caused.clearVote).toBe(true);
    expect(caused.judgments.map((entry) => entry.severity)).toEqual(["pre-existing", "blocking"]);
    const first = noteReviewTag(undefined, "blocking", "opus-high", 1);
    const later = noteReviewTag({ ...first, verification: { by: "voter", verdict: "real", reason: "It fails now.", at: 2 } }, "pre-existing", "sol-high", 3);
    expect(later.severity).toBe("blocking");
    expect(later.clearVote).toBe(false);
    expect(later.judgments.map((entry) => entry.severity)).toEqual(["blocking", "pre-existing"]);
    expect(noteReviewTag({ severity: "pre-existing", judgments: [] }, "suggestion", "sol-high", 4).severity).toBe("pre-existing");
  });

  it("puts 24 matching reports on one card, and the 25th on that same card", async () => {
    const reports = (count: number) => Array.from({ length: count }, (_, index) => report({ taskId: `t${index}`, findingId: "1", text: `The footer link ${index} opens a retired page.` }));
    const asks: { keys: string[]; cards: string[] }[] = [];
    const answer = (ask: MatchAsk): MatchAnswer => {
      asks.push({ keys: ask.reports.map((entry) => entry.key), cards: ask.cards.map((entry) => entry.id) });
      const cardId = ask.cards[0]?.id;
      return { groups: [{ keys: ask.reports.map((entry) => entry.key), ...(cardId ? { cardId } : {}) }] };
    };
    const capped = await planFollowUps(snap(reports(24)), answer);
    expect(asks).toEqual([{ keys: reports(24).map((entry) => entry.key), cards: [] }]);
    expect(capped.created).toHaveLength(1);
    expect(capped.created[0]!.keys).toHaveLength(24);
    asks.length = 0;
    const overflow = await planFollowUps(snap(reports(25)), answer);
    expect(asks[0]!.keys).toHaveLength(24);
    expect(asks[1]!.keys).toHaveLength(1);
    expect(asks[1]!.cards).toHaveLength(1);
    expect(overflow.created).toHaveLength(1);
    expect(overflow.created[0]!.keys).toHaveLength(25);
    expect(overflow.linked).toEqual([]);
  });

  it("does not mark a report tracked while its picture is still missing from the card", async () => {
    const pictured = report({ taskId: "a", findingId: "1", text: "The footer is wrong.", images: [{ caption: "Footer", sourceTaskId: "a", sourceImageId: "pic" }] });
    const waiting = await plan(snap([pictured], { cards: [card({ id: "card", reportKeys: [pictured.key] })] }));
    expect(waiting.tracks.filter((entry) => "taskId" in entry.tracking)).toEqual([]);
    expect(waiting.linked[0]!.reports[0]!.images).toEqual([{ caption: "Footer", sourceTaskId: "a", sourceImageId: "pic" }]);
    const kept = await plan(snap([pictured], { cards: [card({ id: "card", reportKeys: [pictured.key] })], keptImages: [{ cardId: "card", sourceTaskId: "a", sourceImageId: "pic" }] }));
    expect(kept.linked).toEqual([]);
    expect(kept.tracks).toContainEqual({ taskId: "a", findingId: "1", tracking: { taskId: "card" } });
  });

  it("compares a later report with every open card, past the first 20", async () => {
    const reports = Array.from({ length: 24 }, (_, index) => report({ taskId: `t${index}`, findingId: "1", text: `bug-${index}: The footer link ${index} opens a retired page.` }));
    const distinct = (ask: MatchAsk): MatchAnswer => ({ groups: ask.reports.map((entry) => ({ keys: [entry.key] })) });
    const first = await planFollowUps(snap(reports), distinct);
    expect(first.created).toHaveLength(24);
    const cards = first.created.map((entry, index) => card({
      id: `card-${index}`,
      title: entry.title,
      problem: entry.reports[0]!.text,
      reportKeys: [...entry.keys],
    }));
    const repeat = report({ taskId: "again", findingId: "1", text: reports[23]!.text });
    const seen: string[][] = [];
    const bugOf = (text: string) => /^bug-(\d+)/.exec(text)?.[1];
    const second = await planFollowUps(snap([repeat], { cards }), (ask) => {
      seen.push(ask.cards.map((entry) => entry.id));
      return {
        groups: ask.reports.map((entry) => {
          const bug = bugOf(entry.text);
          const shown = ask.cards.find((item) => bugOf(item.problem) === bug || bugOf(item.title) === bug);
          return shown ? { keys: [entry.key], cardId: shown.id } : { keys: [entry.key] };
        }),
      };
    });
    expect(seen.some((ids) => ids.includes("card-23"))).toBe(true);
    expect(second.created).toEqual([]);
    expect(second.linked.map((entry) => entry.cardId)).toEqual(["card-23"]);
  });

  it("asks a finished report before unfinished ones and does not ask the same batch again", async () => {
    const unfinished = Array.from({ length: 24 }, (_, index) => report({ taskId: `u${index}`, findingId: "1", text: `bug-wait: still open ${index}`, sourceDone: false }));
    const done = report({ taskId: "done", findingId: "1", text: "bug-done: The footer opens a retired page." });
    let calls = 0;
    const result = await planFollowUps(snap([...unfinished, done]), (ask) => {
      calls += 1;
      if (calls > 3) throw new Error("match did not settle");
      const waiting = ask.reports.filter((entry) => entry.key !== done.key).map((entry) => entry.key);
      const finished = ask.reports.filter((entry) => entry.key === done.key).map((entry) => entry.key);
      return { groups: [...(finished.length ? [{ keys: finished }] : []), ...(waiting.length ? [{ keys: waiting }] : [])] };
    });
    expect(calls).toBe(1);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.keys).toEqual([done.key]);
    expect(result.tracks.filter((entry) => entry.taskId.startsWith("u"))).toEqual([]);
  });

  it("does not open a card for the report left out of a batch that could not be matched", async () => {
    const reports = (count: number) => Array.from({ length: count }, (_, index) => report({ taskId: `t${index}`, findingId: "1", text: "The footer opens a retired page." }));
    let calls = 0;
    const uncertain = (): MatchAnswer => {
      calls += 1;
      if (calls > 4) throw new Error("match did not settle");
      return { groups: [], uncertain: [] };
    };
    const lost = await planFollowUps(snap(reports(25)), uncertain);
    expect(calls).toBe(1);
    expect(lost.created).toEqual([]);
    expect(lost.linked).toEqual([]);
    expect(lost.tracks).toHaveLength(25);
    expect(lost.tracks.every((entry) => "reason" in entry.tracking && entry.tracking.reason === "unmatched")).toBe(true);
    calls = 0;
    const capped = await planFollowUps(snap(reports(24)), uncertain);
    expect(calls).toBe(1);
    expect(capped.created).toEqual([]);
    expect(capped.tracks).toHaveLength(24);
    const grouped = await planFollowUps(snap(reports(25)), (ask) => {
      const cardId = ask.cards[0]?.id;
      return { groups: [{ keys: ask.reports.map((entry) => entry.key), ...(cardId ? { cardId } : {}) }] };
    });
    expect(grouped.created).toHaveLength(1);
    expect(grouped.created[0]!.keys).toHaveLength(25);
  });
});

describe("sample boards", () => {
  it("shows one backlog card for two worded reports and leaves one follow-up unmatched", () => {
    for (const demo of [createDemo(1), createPortfolioDemo(1)]) {
      const card = demo.state.tasks.find((task) => task.id === "footer-follow-up");
      expect(card?.state).toBe("backlog");
      expect(card?.followUp?.reports).toHaveLength(2);
      expect(new Set(card!.followUp!.reports.map((report) => report.text)).size).toBe(2);
      const source = demo.state.tasks.find((task) => task.id === card!.followUp!.reports[0]!.taskId);
      expect(source?.state).toBe("done");
      const tracked = source!.findings.filter((finding) => finding.tracking && "taskId" in finding.tracking);
      expect(tracked.map((finding) => ("taskId" in finding.tracking! ? finding.tracking.taskId : ""))).toEqual(["footer-follow-up", "footer-follow-up"]);
      expect(source!.findings.find((finding) => finding.tracking && "reason" in finding.tracking && finding.tracking.reason === "unmatched")?.text).toContain("copyright");
    }
  });
});
