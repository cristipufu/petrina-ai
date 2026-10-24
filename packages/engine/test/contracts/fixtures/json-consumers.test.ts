import { afterAll, expect, it } from "bun:test";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Fakes, makeWorld, removeDir, tempDir } from "../../support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

it("uses the same complete-publication contract for live scenarios and workflow scripts", async () => {
  const root = tempDir("petrina-json-consumers-"); roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  const world = await makeWorld("atomic-script"); roots.push(world.dir);
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
