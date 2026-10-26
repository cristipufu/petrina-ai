import { afterAll, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, waitFor } from "@petrina/test-support/fixtures";
import { engineProcessCases, Fakes } from "../../support.js";

const cases = engineProcessCases();
afterAll(() => cases.close());

it("ends both stop-resistant readiness actors when their worker dies without teardown", async () => {
  const root = tempDir("petrina-readiness-owner-loss-");
  return cases.use(root, async owners => {
    const recipe = join(root, "admitted.json"), script = join(root, "owner.ts");
    const fixture = new URL("../../fixtures/shutdown-actors.ts", import.meta.url).href;
    const json = import.meta.resolve("@petrina/test-support/fixture-json");
    // The actual readiness fixture owns its lease in a separate process. There is
    // deliberately no teardown or self-expiry in that owner or either actor.
    writeFileSync(script, `
const { shutdownActors } = await import(${JSON.stringify(fixture)});
const { writeFixtureJson } = await import(${JSON.stringify(json)});
const actors = await shutdownActors(${JSON.stringify(root)});
writeFixtureJson(${JSON.stringify(recipe)}, { actor: actors.actor });
await new Promise(() => undefined);
`);
    const owner = owners.command(root, [script]);
    await waitFor(() => existsSync(recipe), "the readiness owner to publish its actor entry", undefined, { during: owner.completion });
    const { actor } = JSON.parse(readFileSync(recipe, "utf8")) as { actor: string };
    const fakes = new Fakes(join(root, "fake"));
    const actors = [["--hang", "--stubborn"], ["--silent-login", "--stubborn"]]
      .map(flags => owners.command(root, [actor, fakes.dir, ...flags]));
    await waitFor(() => {
      const file = join(fakes.dir, "pids");
      const ready = new Set(existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map(Number) : []);
      return actors.every(child => ready.has(child.pid));
    }, "both real readiness actors to install their stubborn handlers", undefined,
    { during: Promise.race([owner.completion, ...actors.map(child => child.completion)]) });
    expect(actors.map(child => child.exitCode)).toEqual([null, null]);
    owner.kill("SIGKILL");
    expect(await owner.wait()).not.toBe(0);

    // Native completion and drained output must precede the fixture's fallback
    // stops. Saved PID files are observations, never authority for signalling.
    const results = await Promise.all(actors.map(async child => {
      expect(await child.wait()).toBe(78);
      expect(child.exitCode).toBe(78);
      return child.completion;
    }));
    expect(results).toEqual([
      { code: 78, stdout: "", stderr: "" },
      { code: 78, stdout: "", stderr: "" },
    ]);
  });
});
