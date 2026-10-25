import { describe, expect, it } from "vitest";
import { sourceBackgroundFixture } from "../../fixtures/source-background.js";
describe.concurrent("pull request background and source movement", () => {
it("reuses brief background reads only for the same source and forces fresh reads for explicit refreshes", async () => {
    const w = sourceBackgroundFixture();
    const { scope, sources } = w;
      await sources.refresh(scope);
      const count = w.github().calls.length;
      await sources.refresh(scope);
      expect(w.github().calls).toHaveLength(count);
      w.setGitHub((github) => { github.prs.find((pr) => pr.number === 7)!.title = "Changed on GitHub"; });
      await sources.refresh(scope, true);
      expect(scope.work.prBackground!.text).toContain("Changed on GitHub");
      w.setGitHub((github) => { github.prs.push({ ...github.prs.find((pr) => pr.number === 7)!, number: 8, url: "https://github.com/acme/demo/pull/8", title: "Another approved source" }); });
      const source = scope.work.source!;
      if (source.start.kind !== "pull-request") throw new Error("Expected a pull request source");
      scope.work.source = { ...source, start: { ...source.start, number: 8 } };
      await sources.refresh(scope);
      expect(scope.work.prBackground!.text).toContain("PR #8: Another approved source");
  });
});

describe.concurrent("pull request background and source movement", () => {
it("refreshes at the exact freshness boundary and leaves a failed read uncached", async () => {
  const f = sourceBackgroundFixture();
  await f.sources.refresh(f.scope); const initial = f.github().calls.length;
  f.advance(14_999); await f.sources.refresh(f.scope); expect(f.github().calls).toHaveLength(initial);
  f.advance(1); await f.sources.refresh(f.scope); expect(f.github().calls).toHaveLength(initial + 2);
  f.advance(15_000); const saved = structuredClone(f.scope.work.prBackground);
  f.setGitHub(state => { state.prs[0]!.state = "closed"; });
  await expect(f.sources.refresh(f.scope)).rejects.toThrow("is closed");
  expect(f.scope.work.prBackground).toEqual(saved);
  f.setGitHub(state => { state.prs[0]!.state = "open"; state.prs[0]!.title = "Recovered remote observation"; });
  await f.sources.refresh(f.scope);
  expect(f.scope.work.prBackground?.text).toContain("Recovered remote observation");
  expect(f.effects.checkpoints).toBe(3);
});
});
