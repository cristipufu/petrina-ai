import { afterEach, expect, it } from "bun:test";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Fakes } from "../../support.js";
import { repositoryWorldFixtures } from "../../fixtures/repository-worlds.js";
const fixtures = repositoryWorldFixtures();
afterEach(() => fixtures.close());


it("uses the same complete-publication contract for live scenarios and workflow scripts", async () => {
  return fixtures.use("json-consumers", async scope => {
    const root = scope.root;
    const fakes = new Fakes(join(root, "fake"));
    const world = await scope.make("atomic-script");
    const before = { reviewer: "important" } as const, after = { reviewer: "question" } as const;
    fakes.scenario(before); world.setScript(script => Object.assign(script, before));
    for (const [path, update] of [
      [join(fakes.dir, "scenario.json"), () => fakes.scenario(after)],
      [join(world.dir, "agents.json"), () => world.setScript(script => Object.assign(script, after))],
    ] as const) {
      const reader = openSync(path, "r");
      try {
        update();
        expect(JSON.parse(readFileSync(reader, "utf8"))).toEqual(before);
        expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(after);
      } finally { closeSync(reader); }
    }

  });
});
