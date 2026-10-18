// Polling several pull requests at once must not make the GitHub stand-in lose state or recorded calls.
import { expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_GH, makeWorld, removeDir, waitForFile } from "./support.js";

it("parallel GitHub checks preserve a teammate's update and every recorded call", async () => {
  const w = makeWorld("github-concurrent");
  const path = join(w.dir, "github.json");
  const hold = join(w.dir, "update-hold");
  const writer = join(w.dir, "update.mjs");
  w.setGitHub((github) => github.prs.push({ number: 1, url: "https://github.com/acme/demo/pull/1", headRefName: "task", baseRefName: "main", headRefOid: w.initial, state: "OPEN", isCrossRepository: false, title: "Greeting", body: "" }));
  writeFileSync(hold, "");
  writeFileSync(writer, `import { updateGitHub } from ${JSON.stringify(FAKE_GH)};
    import { existsSync, writeFileSync } from "node:fs";
    updateGitHub(${JSON.stringify(path)}, (github) => {
      writeFileSync(${JSON.stringify(`${hold}.reached`)}, "");
      while (existsSync(${JSON.stringify(hold)})) Bun.sleepSync(10);
      github.prs[0].state = "CLOSED";
    });`);
  const update = Bun.spawn([process.execPath, writer], { stdout: "ignore", stderr: "pipe", windowsHide: true });
  const check = () => Bun.spawn([process.execPath, FAKE_GH, path, w.remote, "pr", "view", "1", "--json", "state", "--jq", ".state", "--repo", "acme/demo"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const lookups: ReturnType<typeof check>[] = [];
  try {
    await waitForFile(`${hold}.reached`);
    for (let index = 0; index < 24; index += 1) lookups.push(check());
    await Bun.sleep(100);
    rmSync(hold);
    expect(await update.exited).toBe(0);
    const results = await Promise.all(lookups.map(async (lookup) => ({ code: await lookup.exited, out: await new Response(lookup.stdout).text() })));
    expect(results).toEqual(Array.from({ length: 24 }, () => ({ code: 0, out: "CLOSED\n" })));
    expect(w.github().prs[0]!.state).toBe("CLOSED");
    expect(w.github().calls).toHaveLength(24);
    expect(existsSync(`${path}.lock`)).toBe(false);
  } finally {
    rmSync(hold, { force: true });
    await update.exited;
    await Promise.all(lookups.map((lookup) => lookup.exited));
    removeDir(w.dir);
  }
});
