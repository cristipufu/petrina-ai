import { afterEach, expect, it, spyOn } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { completeAll } from "@petrina/core";
import { githubService } from "@petrina/repositories/github-service";
import { expectRejection } from "@petrina/test-support/rejections";
import { FAKE_GH, gitWith, waitForFile } from "../../support.js";
import { scriptedGitHub } from "../../scripted-github.js";
import { repositoryWorldFixtures } from "../../fixtures/repository-worlds.js";

const fixtures = repositoryWorldFixtures();
afterEach(() => fixtures.close());

it("keeps native and in-process GitHub answers equivalent while removing the CLI child", async () => {
  await fixtures.use("github-service-parity", async scope => {
    const observed: { mode: string; calls: string[][]; bun: number }[] = [];
    for (const mode of ["native", "service"] as const) {
      const world = await scope.make(mode);
      const path = join(world.dir, "github.json");
      const service = mode === "native" ? githubService([process.execPath, FAKE_GH, path, world.remote])
        : scriptedGitHub({ "acme/demo": { state: path, remote: world.remote } });
      await gitWith({}, "--git-dir", world.remote, "update-ref", "refs/tags/v1.0.0", world.initial);
      let bun = 0;
      const spawn = Bun.spawn;
      const spying = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
        const first = args[0] as readonly string[] | { cmd: readonly string[] };
        const command = "cmd" in first ? first.cmd : first;
        if (command?.[0] && /^bun(?:\.exe)?$/.test(basename(command[0]))) bun += 1;
        return spawn(...args);
      }) as typeof Bun.spawn);
      try {
        expect(await service.repository("acme/demo")).toEqual({ repo: "acme/demo", defaultBranch: "main" });
        await service.requireBranch("acme/demo", "main");
        await expectRejection(service.requireBranch("acme/demo", "missing"), "The branch missing is unavailable");
        expect(await service.latestRelease("acme/demo")).toEqual({ ok: true, value: undefined });
        expect(await service.openPullRequest("acme/demo", { head: "main", base: "main", title: "A title; $(literal)", body: "First line\n\nUnicode: été\n" })).toEqual({ ok: true, url: "https://github.com/acme/demo/pull/1" });
        expect(await service.openPullRequest("acme/demo", { head: "main", base: "main", title: "Duplicate", body: "Must not replace the existing body" })).toMatchObject({ ok: false, exists: true });
        const pr = await service.sourcePr("acme/demo", 1);
        expect(pr).toMatchObject({ head: world.initial, branch: "main", headRepo: "acme/demo", title: "A title; $(literal)", body: "First line\n\nUnicode: été\n" });
        expect(await service.pullRequests("acme/demo", "main")).toMatchObject({ ok: true, value: [{ number: 1, commit: world.initial, fork: false }] });
        world.setGitHub(state => { state.lose = { "pr comment": 1 }; });
        await expectRejection(service.comment("acme/demo", 1, "Companion link"), "error connecting");
        expect(await service.comments("acme/demo", 1)).toEqual([{ body: "Companion link" }]);
        expect(await service.background("acme/demo", pr)).toContain("Companion link");
        await service.editDescription("acme/demo", 1, "Updated description\n");
        expect(await service.description("acme/demo", 1)).toBe("Updated description\n");
        expect(await service.createRelease("acme/demo", "v1.0.0", "Release notes\n")).toEqual({ ok: true, url: "https://github.com/acme/demo/releases/tag/v1.0.0" });
        expect(await service.createRelease("acme/demo", "v1.0.0", "Duplicate notes")).toMatchObject({ ok: false, exists: true });
        expect(await service.findRelease("acme/demo", "v1.0.0")).toEqual({ ok: true, value: { tag: "v1.0.0", url: "https://github.com/acme/demo/releases/tag/v1.0.0", draft: false } });
        world.setGitHub(state => { state.stale = { "release view": 1 }; });
        expect(await service.findRelease("acme/demo", "v1.0.0")).toEqual({ ok: true, value: undefined });
        world.setGitHub(state => { state.meanwhile = { command: "release view", withTag: true, times: 1, release: "v2.0.0" }; });
        expect((await service.findRelease("acme/demo", "v1.0.0")).ok).toBe(true);
        expect(await service.latestRelease("acme/demo")).toEqual({ ok: true, value: "v2.0.0" });
        expect(world.github().meanwhile?.times).toBe(0);
        expect(world.github().releases.map(release => release.tagName)).toEqual(["v1.0.0", "v2.0.0"]);
        world.setGitHub(state => { state.hidden = true; });
        expect((await service.findRelease("acme/demo", "missing")).ok).toBe(false);
        world.setGitHub(state => { state.hidden = false; state.fail = { "pr view": 1 }; });
        await expectRejection(service.description("acme/demo", 1), "Could not read the companion links");
        expect(await service.prState("acme/demo", 1)).toBe("open");
        observed.push({ mode, calls: world.github().calls, bun });
      } finally { spying.mockRestore(); }
      expect(existsSync(`${path}.lock`)).toBe(false);
    }
    // Background reads are peers: native process scheduling does not prescribe their arrival order.
    expect(observed[0]!.calls.map(call => JSON.stringify(call)).sort()).toEqual(observed[1]!.calls.map(call => JSON.stringify(call)).sort());
    expect(observed[0]!.bun).toBeGreaterThan(0);
    expect(observed[1]!.bun).toBe(0);
  });
});

it("preserves edits and every concurrent publication while native Git and held replies are pending", async () => {
  let release = () => {};
  await fixtures.use("github-service-concurrency", async scope => {
    const world = await scope.make("private");
    const path = join(world.dir, "github.json"), hold = join(world.dir, "hold");
    const service = scriptedGitHub({ "acme/demo": { state: path, remote: world.remote } });
    const count = 8;
    for (let index = 0; index < count; index++) {
      writeFileSync(join(world.remote, "refs", "heads", `topic-${index}`), `${world.initial}\n`);
    }
    writeFileSync(hold, "");
    release = () => rmSync(hold, { force: true });
    world.setGitHub(state => { state.hold = { command: "pr create", file: hold }; });
    // Each call reaches its real Git lookup before the synchronous script update below.
    const pending = completeAll(Array.from({ length: count }, (_, index) => service.openPullRequest("acme/demo", { head: `topic-${index}`, base: "main", title: `Task ${index}`, body: "Description" })));
    world.setGitHub(state => { state.pages = { "issues/1/comments?per_page=100": [[{ body: "A teammate's concurrent note" }]] }; });
    try {
      await waitForFile(`${hold}.reached`, { during: pending });
      world.setGitHub(state => { state.lose = { "pr create": 1 }; state.hidden = false; });
      release();
      const results = await pending;
      expect(results.filter(result => result.ok)).toHaveLength(count - 1);
      expect(world.github().prs).toHaveLength(count);
      expect(new Set(world.github().prs.map(pr => pr.number)).size).toBe(count);
      expect(world.github().calls).toHaveLength(count);
      expect(await service.comments("acme/demo", 1)).toEqual([{ body: "A teammate's concurrent note" }]);
      expect(world.github().lose?.["pr create"]).toBe(0);
      // PR reads refresh the same actual refs/pull/1/head. They must not race Git's ref lock.
      const reads = completeAll(Array.from({ length: 12 }, () => service.sourcePr("acme/demo", 1)));
      world.setGitHub(state => { state.pages!["issues/1/comments?per_page=100"]![0] = [{ body: "Edited during the native refresh" }]; });
      expect((await reads).map(pr => pr.head)).toEqual(Array.from({ length: 12 }, () => world.initial));
      expect(await service.comments("acme/demo", 1)).toEqual([{ body: "Edited during the native refresh" }]);
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally { release(); await pending; }
  }, { stopPeers: () => release() });
});
