// Polling several pull requests at once must not make the GitHub stand-in lose state or recorded calls.
import { expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_GH, makeWorld, removeDir, runCommand, waitForFile } from "../../support.js";

it("parallel GitHub checks preserve a teammate's update and every recorded call", async () => {
  const w = await makeWorld("github-concurrent");
  const path = join(w.dir, "github.json");
  const hold = join(w.dir, "update-hold");
  const writer = join(w.dir, "update.mjs");
  const reader = join(w.dir, "read.mjs");
  w.setGitHub((github) => github.prs.push({ number: 1, url: "https://github.com/acme/demo/pull/1", headRefName: "task", baseRefName: "main", headRefOid: w.initial, state: "OPEN", isCrossRepository: false, title: "Greeting", body: "" }));
  writeFileSync(hold, "");
  writeFileSync(writer, `import { updateGitHub } from ${JSON.stringify(FAKE_GH)};
    import { existsSync, writeFileSync } from "node:fs";
    updateGitHub(${JSON.stringify(path)}, (github) => {
      writeFileSync(${JSON.stringify(`${hold}.reached`)}, "");
      while (existsSync(${JSON.stringify(hold)})) Bun.sleepSync(10);
      github.prs[0].state = "CLOSED";
    });`);
  writeFileSync(reader, `import { runFakeGitHub } from ${JSON.stringify(FAKE_GH)};
    import { writeFixtureJson } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/fixture-json"))};
    const [state, remote, receipt, ...args] = process.argv.slice(2);
    await runFakeGitHub([state, remote, ...args], () => writeFixtureJson(receipt, { blocked: true }));`);
  const controller = new AbortController();
  const update = runCommand([process.execPath, writer], { signal: controller.signal });
  const receipts = Array.from({ length: 24 }, (_, index) => join(w.dir, `reader-${index}.json`));
  const check = (receipt: string) => runCommand([process.execPath, reader, path, w.remote, receipt, "pr", "view", "1", "--json", "state", "--jq", ".state", "--repo", "acme/demo"], { signal: controller.signal });
  let lookups: ReturnType<typeof check>[] = [];
  try {
    await waitForFile(`${hold}.reached`, { during: update });
    const pending = receipts.map(receipt => check(receipt));
    lookups = pending;
    await Promise.all(receipts.map((receipt, index) => waitForFile(receipt, { during: pending[index]! })));
    rmSync(hold);
    expect((await update).code).toBe(0);
    const completed = await Promise.all(pending);
    const results = completed.map(result => ({ code: result.code, out: result.stdout }));
    expect(results).toEqual(Array.from({ length: 24 }, () => ({ code: 0, out: "CLOSED\n" })));
    expect(w.github().prs[0]!.state).toBe("CLOSED");
    expect(w.github().calls).toHaveLength(24);
    expect(existsSync(`${path}.lock`)).toBe(false);
  } finally {
    rmSync(hold, { force: true });
    controller.abort();
    await Promise.allSettled([update, ...lookups]);
    removeDir(w.dir);
  }
});

it("answers not found only when Git confirms a ref is absent, and fails when Git cannot read GitHub's copy", async () => {
  const w = await makeWorld("github-lookups");
  const path = join(w.dir, "github.json");
  const gh = (remote: string, ...args: string[]) => runCommand([process.execPath, FAKE_GH, path, remote, ...args, ...(args[0] === "api" ? ["--paginate", "--slurp"] : ["--repo", "acme/demo"])]);
  try {
    w.setGitHub((github) => github.prs.push({ number: 1, url: "https://github.com/acme/demo/pull/1", headRefName: "gone", baseRefName: "main", headRefOid: w.initial, state: "OPEN", isCrossRepository: false, title: "Greeting", body: "" }));
    expect(await gh(w.remote, "api", "repos/acme/demo/branches/main")).toEqual({ code: 0, stdout: `${JSON.stringify([{ commit: { sha: w.initial } }])}\n`, stderr: "" });
    expect(await gh(w.remote, "api", "repos/acme/demo/branches/gone")).toEqual({ code: 1, stdout: "", stderr: "HTTP 404: branch not found\n" });
    // A deleted branch keeps its pull request at its former head.
    expect(await gh(w.remote, "pr", "view", "1", "--json", "headRefOid")).toEqual({ code: 0, stdout: `${JSON.stringify({ headRefOid: w.initial })}\n`, stderr: "" });
    const broken = join(w.dir, "not-a-repository");
    mkdirSync(broken);
    for (const args of [["api", "repos/acme/demo/branches/main"], ["pr", "view", "1", "--json", "headRefOid"], ["pr", "list", "--head", "gone", "--json", "number"]]) {
      const failed = await gh(broken, ...args);
      expect(failed.code).not.toBe(0);
      expect(failed.stdout).toBe("");
      expect(failed.stderr).toContain("not a git repository");
      expect(failed.stderr).not.toContain("not found");
    }
    expect(existsSync(`${path}.lock`)).toBe(false);
  } finally { removeDir(w.dir); }
});
