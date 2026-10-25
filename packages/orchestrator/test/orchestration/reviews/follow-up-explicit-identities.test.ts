import { expect, it } from "vitest";
import { followUpLinksFixture, older } from "../../fixtures/follow-up-links.js";

it("follows a chosen card, keeps a refusal off it, and matches a missing choice", async () => {
  const f = followUpLinksFixture();

  try {
    const known = f.taskOf(f.shop, "Known footer", [older("known", "bug-known: The footer opens a retired page.")]);
    await f.finish(known);
    const card = f.cardFor("known")[0]!;
    const before = f.prompts.length;
    const pointed = f.taskOf(f.shop, "Pointed", [older("pointed", "bug-other: Words that do not match the card.", { cardsShown: [card.id], sameBug: card.id })]);
    await f.finish(pointed);
    expect(pointed.findings[0]!.tracking).toEqual({ taskId: card.id });
    expect(card.followUp!.reports.map((report) => report.findingId)).toContain("pointed");
    expect(f.prompts.length).toBe(before);

    const refused = f.taskOf(f.shop, "Refused", [older("refused", "bug-fresh: A different footer bug.", { cardsShown: [card.id], sameBug: "none" })]);
    const pair = f.taskOf(f.shop, "Paired refusal", [older("pair", "bug-fresh: The same different footer bug.", { cardsShown: [card.id], sameBug: "none" })]);
    const silent = f.taskOf(f.shop, "No choice", [older("silent", "bug-silent: Nobody chose a card.", { cardsShown: [card.id] })]);
    await f.finish(refused);
    await f.finish(pair);
    const fresh = f.cardFor("fresh");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.id).not.toBe(card.id);
    expect(fresh[0]!.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["pair", "refused"]);
    expect(card.followUp!.reports.map((report) => report.findingId)).not.toContain("refused");

    await f.finish(silent);
    expect(silent.findings[0]!.tracking).toEqual({ taskId: f.cardFor("silent")[0]!.id });
    expect(card.followUp!.reports.map(report => report.findingId)).not.toContain("silent");
    const same = f.taskOf(f.shop, "Skipped same bug", [older("same", "bug-known: Another wording of the known bug", { cardsShown: [card.id] })]);
    await f.finish(same);
    expect(f.prompts.at(-1)).toContain(`Card [${card.id}]`);
    expect(same.findings[0]!.tracking).toEqual({ taskId: card.id });
    expect(card.followUp!.reports.map(report => report.findingId)).toContain("same");
  } finally { await f.stop(); }
});
