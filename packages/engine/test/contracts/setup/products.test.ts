import { expectRejection } from "@petrina/test-support/rejections";
import { executionFor } from "@petrina/orchestrator";
import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { Connections } from "../../../src/connection.js";
import { Engine } from "../../engine.js";
import { findClones } from "@petrina/repositories/discovery";
import { git } from "@petrina/test-support/commands";
import { makeProduct } from "@petrina/test-support/repositories";
import { setupFixtures } from "../../fixtures/setup.js";

const { fresh, agents, sentences, refusal, clone, makeGitHubClone } = setupFixtures();


;
;
;
;
describe("The clone finder", () => {
it("hides products already added", async () => {
    const home = fresh("home");
    const repo = await makeGitHubClone(join(home, "code", "shop"));
    clone(join(home, "code", "blog"), "https://github.com/acme/blog.git", Date.now());
    const engine = new Engine(fresh("data"), { home, agentCommand: agents({}) });
    try {
      expect((await engine.findClones()).map((entry) => entry.repo).sort()).toEqual(["acme/blog", "acme/shop"]);
      await engine.addProduct(repo);
      expect((await engine.findClones()).map((entry) => entry.repo)).toEqual(["acme/blog"]);
      // Saved paths may use another spelling of the same folder (Git uses forward slashes on Windows).
      engine.s.products[0]!.path = `${repo}${sep}.`;
      expect((await engine.findClones()).map((entry) => entry.repo)).toEqual(["acme/blog"]);
    } finally {
      await engine.shutdown();
    }
  });
});
describe("Adding a product", () => {
it("takes ~ and subfolders, and says plainly why a folder cannot be added", async () => {
    const home = fresh("home");
    const repo = await makeGitHubClone(join(home, "code", "shop"));
    const local = await makeProduct(fresh("local"));
    writeFileSync(join(home, "notes.txt"), "not a folder\n");
    mkdirSync(join(home, "plain"));
    const engine = new Engine(fresh("data"), { home, agentCommand: agents({}) });
    try {
      const id = await engine.addProduct("~/code/shop/src/checkout");
      const product = engine.getState().products.find((entry) => entry.id === id)!;
      expect(product.repo).toBe("acme/shop");
      expect(product.delivery).toBe("pull-request");
      expect(product.path && await git(product.path, "rev-parse", "--show-toplevel")).toBe(await git(repo, "rev-parse", "--show-toplevel"));
      // Adding it again opens the one already there, never a second product.
      expect(await engine.addProduct(repo)).toBe(id);
      await expectRejection(engine.addProduct("~/nowhere"), "There is no folder at ~/nowhere.");
      await expectRejection(engine.addProduct("~/notes.txt"), "~/notes.txt is a file, so pick the folder you cloned the product into.");
      await expectRejection(engine.addProduct("~/plain"), "That folder isn't a copy of a repository, so pick the folder you cloned the product into.");
      // Each refusal is one plain sentence.
      for (const input of ["~/nowhere", "~/notes.txt", "~/plain"]) expect(sentences(await refusal(engine.addProduct(input)))).toBe(1);
      // A clone that is not linked to GitHub keeps its finished work on this machine.
      const localId = await engine.addProduct(local);
      expect(engine.getState().products.find((entry) => entry.id === localId)?.delivery).toBe("local");
      expect(engine.getState().products).toHaveLength(2);
    } finally {
      await engine.shutdown();
    }
    const noGit = new Engine(fresh("data"), { home, which: (name) => (name === "git" ? null : Bun.which(name)) });
    try {
      await expectRejection(noGit.addProduct(repo), /Git isn't installed: run .+ then try again/);
      expect(sentences(await refusal(noGit.addProduct(repo)))).toBe(1);
    } finally {
      await noGit.shutdown();
    }
  });
});
describe("Adding a product", () => {
it("adds an http or git-protocol GitHub clone as a pull request", async () => {
    const home = fresh("schemes");
    const httpRepo = await makeGitHubClone(join(home, "code", "http-shop"));
    await git(httpRepo, "remote", "set-url", "origin", "http://github.com/acme/http-shop.git");
    const gitRepo = await makeGitHubClone(join(home, "code", "git-shop"));
    await git(gitRepo, "remote", "set-url", "origin", "git://github.com/acme/git-shop.git");
    const elsewhere = await makeGitHubClone(join(home, "code", "elsewhere"));
    await git(elsewhere, "remote", "set-url", "origin", "http://gitlab.com/acme/elsewhere.git");
    const engine = new Engine(fresh("data"), { home, agentCommand: agents({}) });
    try {
      expect((await findClones({ home })).map((entry) => entry.repo).sort()).toEqual(["acme/git-shop", "acme/http-shop"]);
      for (const path of [httpRepo, gitRepo]) {
        const id = await engine.addProduct(path);
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
      const localId = await engine.addProduct(elsewhere);
      expect(engine.getState().products.find((entry) => entry.id === localId)?.delivery).toBe("local");
    } finally {
      await engine.shutdown();
    }
  });
});
;
