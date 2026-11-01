import { afterAll } from "bun:test";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { expectRejection } from "@petrina/test-support/rejections";
import { executionFor } from "@petrina/orchestrator";
import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { Connections } from "../../../src/connection.js";
import { dispatch } from "../../../src/server.js";
import { findClones } from "@petrina/repositories/discovery";
import { git } from "@petrina/test-support/commands";
import { makeProduct } from "@petrina/test-support/repositories";
import { setupFixtures } from "../../fixtures/setup.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";
const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());


const { fresh, agents, sentences, refusal, nativeProbeOnly, clone, makeGitHubClone } = setupFixtures();


;
;
;
;
describe("The clone finder", () => {
it("hides products already added", async () => {
  return engineCases.use("petrina-setup-case-", async caseOwner => {
    const home = fresh("home", caseOwner.root);
    const repo = await makeGitHubClone(join(home, "code", "shop"));
    clone(join(home, "code", "blog"), "https://github.com/acme/blog.git", Date.now());
    const engine = caseOwner.open(fresh("data", caseOwner.root), { home, agentCommand: agents({}), toolProbe: privateAgentToolProbe() });
    try {
      await caseOwner.run(engine, async () => { expect((await engine.findClones()).map((entry) => entry.repo).sort()).toEqual(["acme/blog", "acme/shop"]); });
      await caseOwner.run(engine, async () => { await engine.addProduct(repo); });
      await caseOwner.run(engine, async () => { expect((await engine.findClones()).map((entry) => entry.repo)).toEqual(["acme/blog"]); });
      // Saved paths may use another spelling of the same folder (Git uses forward slashes on Windows).
      engine.s.products[0]!.path = `${repo}${sep}.`;
      await caseOwner.run(engine, async () => { expect((await engine.findClones()).map((entry) => entry.repo)).toEqual(["acme/blog"]); });
    } finally {
      await caseOwner.stop(engine);
    }

  });
});
});
describe("Adding a product", () => {
it("takes ~ and subfolders, and says plainly why a folder cannot be added", async () => {
  return engineCases.use("petrina-setup-case-", async caseOwner => {
    const home = fresh("home", caseOwner.root);
    const repo = await makeGitHubClone(join(home, "code", "shop"));
    const local = await makeProduct(fresh("local", caseOwner.root));
    writeFileSync(join(home, "notes.txt"), "not a folder\n");
    mkdirSync(join(home, "plain"));
    const engine = caseOwner.open(fresh("data", caseOwner.root), { home, agentCommand: agents({}), toolProbe: privateAgentToolProbe() });
    try {
      const id = await caseOwner.run(engine, async () => engine.addProduct("~/code/shop/src/checkout"));
      const product = engine.getState().products.find((entry) => entry.id === id)!;
      expect(product.repo).toBe("acme/shop");
      expect(product.delivery).toBe("pull-request");
      expect(product.path && await git(product.path, "rev-parse", "--show-toplevel")).toBe(await git(repo, "rev-parse", "--show-toplevel"));
      // Adding it again opens the one already there, never a second product.
      await caseOwner.run(engine, async () => { expect(await engine.addProduct(repo)).toBe(id); });
      await caseOwner.run(engine, async () => { await expectRejection(engine.addProduct("~/nowhere"), "There is no folder at ~/nowhere."); });
      await caseOwner.run(engine, async () => { await expectRejection(engine.addProduct("~/notes.txt"), "~/notes.txt is a file, so pick the folder you cloned the product into."); });
      await caseOwner.run(engine, async () => { await expectRejection(engine.addProduct("~/plain"), "That folder isn't a copy of a repository, so pick the folder you cloned the product into."); });
      // Each refusal is one plain sentence.
      for (const input of ["~/nowhere", "~/notes.txt", "~/plain"]) await caseOwner.run(engine, async () => { expect(sentences(await refusal(engine.addProduct(input)))).toBe(1); });
      // A clone that is not linked to GitHub keeps its finished work on this machine.
      const localId = await caseOwner.run(engine, async () => engine.addProduct(local));
      expect(engine.getState().products.find((entry) => entry.id === localId)?.delivery).toBe("local");
      expect(engine.getState().products).toHaveLength(2);
    } finally {
      await caseOwner.stop(engine);
    }
    const noGit = caseOwner.open(fresh("data", caseOwner.root), { home, toolProbe: nativeProbeOnly(() => noGit, "git"), which: (name) => (name === "git" ? null : Bun.which(name)) });
    try {
      await caseOwner.run(noGit, async () => { await expectRejection(noGit.addProduct(repo), /Git isn't installed: run .+ then try again/); });
      await caseOwner.run(noGit, async () => { expect(sentences(await refusal(noGit.addProduct(repo)))).toBe(1); });
    } finally {
      await caseOwner.stop(noGit);
    }

  });
});
});
describe("Adding a product", () => {
it("adds an http or git-protocol GitHub clone as a pull request", async () => {
  return engineCases.use("petrina-setup-case-", async caseOwner => {
    const home = fresh("schemes", caseOwner.root);
    const httpRepo = await makeGitHubClone(join(home, "code", "http-shop"));
    await git(httpRepo, "remote", "set-url", "origin", "http://github.com/acme/http-shop.git");
    const gitRepo = await makeGitHubClone(join(home, "code", "git-shop"));
    await git(gitRepo, "remote", "set-url", "origin", "git://github.com/acme/git-shop.git");
    const elsewhere = await makeGitHubClone(join(home, "code", "elsewhere"));
    await git(elsewhere, "remote", "set-url", "origin", "http://gitlab.com/acme/elsewhere.git");
    const engine = caseOwner.open(fresh("data", caseOwner.root), { home, agentCommand: agents({}), toolProbe: privateAgentToolProbe() });
    try {
      expect((await findClones({ home })).map((entry) => entry.repo).sort()).toEqual(["acme/git-shop", "acme/http-shop"]);
      for (const path of [httpRepo, gitRepo]) {
        const id = await caseOwner.run(engine, async () => engine.addProduct(path));
        const product = engine.getState().products.find((entry) => entry.id === id)!;
        expect(product.delivery).toBe("pull-request");
        // Test the real connection used by fetch and shipping, without a remote override hiding a
        // refused transport; adding the clone alone did not prove that it could be delivered.
        engine.setPoolPaused(true);
        const taskId = engine.addTask({ productId: id, title: "First task" });
        const task = engine.task(taskId)!;
        const connections = new Connections(engine);
        const remote = { url: `https://github.com/${product.repo}.git` };
        expect(await connections.connection(executionFor(task), new AbortController().signal)).toEqual({ ok: true, remote });
        expect(connections.savedRemote(executionFor(task))).toEqual(remote);
        expect(product.remote).toBe(await git(path, "config", "--get", "remote.origin.url"));
      }
      const localId = await caseOwner.run(engine, async () => engine.addProduct(elsewhere));
      expect(engine.getState().products.find((entry) => entry.id === localId)?.delivery).toBe("local");
    } finally {
      await caseOwner.stop(engine);
    }

  });
});

  it("deduplicates concurrent pickFolder calls and defaults to null in fixture mode without GUI dialogs", async () => {
    return engineCases.use("petrina-pick-folder-", async (caseOwner) => {
      const defaultEngine = caseOwner.open(fresh("default-data", caseOwner.root), {
        agentCommand: agents({}),
        toolProbe: privateAgentToolProbe(),
      });
      try {
        expect(await caseOwner.run(defaultEngine, () => dispatch(defaultEngine, { name: "pickFolder", args: [] }))).toBeNull();
      } finally {
        await caseOwner.stop(defaultEngine);
      }

      let calls = 0;
      let release: ((value: string | null) => void) | undefined;
      caseOwner.onStop(() => release?.(null));
      const customEngine = caseOwner.open(fresh("custom-data", caseOwner.root), {
        agentCommand: agents({}),
        toolProbe: privateAgentToolProbe(),
        pickFolder: () => {
          calls += 1;
          return new Promise<string | null>((resolve) => {
            release = resolve;
          });
        },
      });
      try {
        const first = caseOwner.run(customEngine, () => dispatch(customEngine, { name: "pickFolder", args: [] }));
        const second = caseOwner.run(customEngine, () => dispatch(customEngine, { name: "pickFolder", args: [] }));
        expect(calls).toBe(1);
        release?.("/Users/dev/Documents/Github/petrina-ai");
        expect(await Promise.all([first, second])).toEqual([
          "/Users/dev/Documents/Github/petrina-ai",
          "/Users/dev/Documents/Github/petrina-ai",
        ]);

        const third = caseOwner.run(customEngine, () => dispatch(customEngine, { name: "pickFolder", args: [] }));
        expect(calls).toBe(2);
        release?.(null);
        expect(await third).toBeNull();
      } finally {
        await caseOwner.stop(customEngine);
      }
    });
  });
});

