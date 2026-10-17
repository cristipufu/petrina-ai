// Petrina's credentialed git steps trust none of the repository's own settings (agents can change them):
// they refuse unsafe settings, use only the address saved when the product was added, carry only what
// Petrina names, run no hook, and run one at a time per product.
import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { State } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { ADDRESS, coordinator, FAKE_AGENT, FAKE_GH, finish, git, itemOf, makeWorld, removeDir, remoteRef, taskOf, until, type World } from "./support.js";

const worlds: World[] = [];
const world = (...args: Parameters<typeof makeWorld>) => {
  const made = makeWorld(...args);
  worlds.push(made);
  return made;
};
afterAll(() => {
  for (const made of worlds) removeDir(made.dir);
});

/** A program that leaves a mark when anything runs it. */
function planted(w: World, name: string): { script: string; marks: () => string[] } {
  const marks = join(w.dir, "marks");
  mkdirSync(marks, { recursive: true });
  const script = join(w.dir, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\ntouch ${join(marks, name)}\nexit 1\n`);
  chmodSync(script, 0o755);
  return { script, marks: () => readdirSync(marks) };
}

describe.skipIf(process.platform === "win32")("Petrina's credentialed git steps trust none of the repository's own settings", () => {
  it("refuses to fetch or publish once unsafe settings are planted after setup, and runs none of them", async () => {
    const w = world("planted");
    const program = planted(w, "evil");
    const included = join(w.dir, "included.gitconfig");
    writeFileSync(included, `[core]\n\tsshCommand = ${program.script}\n`);
    const plants: [string, string[]][] = [
      ["credential.helper", ["credential.helper", `!${program.script}`]],
      ["core.sshcommand", ["core.sshCommand", program.script]],
      ["url.", ["url.https://evil.example/.insteadOf", "https://github.com/"]],
      ["http.proxy", ["http.proxy", "http://127.0.0.1:9"]],
      ["include.path", ["include.path", included]],
      ["core.fsmonitor", ["core.fsmonitor", program.script]],
    ];
    const engine = w.start();
    try {
      const productId = await engine.addProduct(w.clone);
      engine.setProductDelivery(productId, "pull-request", false);
      for (const [key, setting] of [...plants, ["credential.helper", ["--worktree", "credential.helper", `!${program.script}`]] as [string, string[]]]) {
        if (setting[0] === "--worktree") git(w.clone, "config", "extensions.worktreeConfig", "true");
        git(w.clone, "config", ...setting);
        const taskId = engine.addTask({ productId, title: `Planted ${key}`, description: "A greeting file. [quick]" });
        const task = taskOf(await finish(engine, taskId), taskId);
        expect(task.state).toBe("failed");
        expect(task.error).toContain("could not get the latest main from GitHub (the repository's git settings include");
        expect(task.error).toContain(key);
        expect(task.timeline.some((entry) => entry.tone === "warn" && entry.text.includes("could misuse your GitHub login"))).toBe(true);
        expect(remoteRef(w.remote, `refs/heads/${task.branch}`)).toBeUndefined();
        git(w.clone, "config", ...(setting[0] === "--worktree" ? ["--worktree", "--unset-all", setting[1]!] : ["--unset-all", setting[0]!]));
        if (setting[0] === "--worktree") git(w.clone, "config", "--unset", "extensions.worktreeConfig");
        engine.cancel(taskId);
      }
      expect(program.marks()).toEqual([]);
      expect(w.github().calls).toEqual([]);
    } finally {
      engine.shutdown();
    }
  });

  for (const mode of ["pull-request", "release"] as const) {
    it(`publishes a ${mode} only to the saved address, with no hooks, extra tags or submodules, whatever the remote, push address and hooks now say`, async () => {
      const w = world(`redirect-${mode}`);
      const evil = join(w.dir, "evil.git");
      git(w.dir, "init", "-q", "--bare", "-b", "main", evil);
      // A submodule whose newest commit is only local; the work being pushed points at it.
      const libOrigin = join(w.dir, "lib.git");
      git(w.dir, "init", "-q", "--bare", "-b", "main", libOrigin);
      const lib = join(w.dir, "lib");
      git(w.dir, "init", "-q", "-b", "main", lib);
      git(lib, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "Library");
      git(lib, "push", "-q", libOrigin, "main");
      git(w.clone, "-c", "protocol.file.allow=always", "submodule", "add", "-q", libOrigin, "lib");
      git(w.clone, "commit", "-q", "-m", "Add the library");
      git(w.clone, "push", "-q", w.remote, "main");
      git(join(w.clone, "lib"), "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "Not pushed");
      const unpushed = git(join(w.clone, "lib"), "rev-parse", "HEAD");
      w.setScript((script) => (script.gitlink = { path: "lib", sha: unpushed }));
      const libHas = () => {
        try {
          execFileSync("git", ["--git-dir", libOrigin, "cat-file", "-e", `${unpushed}^{commit}`], { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      };
      // An extra annotated tag on work that gets pushed.
      git(w.clone, "tag", "-a", "planted", "-m", "Should never travel", "HEAD");
      // Hooks that run around pushes, checkouts and ref changes: none of Petrina's own git steps may run them.
      // (Commit hooks are the repository's checks, which Petrina runs on purpose, without a login.)
      const hook = planted(w, "hook");
      const hooks = join(w.dir, "hooks");
      mkdirSync(hooks);
      for (const name of ["pre-push", "post-checkout", "reference-transaction", "post-merge"]) {
        writeFileSync(join(hooks, name), `#!/bin/sh\n${hook.script}\n`);
        chmodSync(join(hooks, name), 0o755);
        writeFileSync(join(w.clone, ".git", "hooks", name), `#!/bin/sh\n${hook.script}\n`);
        chmodSync(join(w.clone, ".git", "hooks", name), 0o755);
      }
      // The coordinator's own settings push tags along and push submodules too.
      const globalConfig = join(w.dir, "global.gitconfig");
      writeFileSync(globalConfig, '[push]\n\tfollowTags = true\n\trecurseSubmodules = on-demand\n[protocol "file"]\n\tallow = always\n');
      const before = process.env.GIT_CONFIG_GLOBAL;
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
      const engine = w.start();
      try {
        const productId = await engine.addProduct(w.clone);
        engine.setProductDelivery(productId, mode, false);
        // Planted after setup: a new remote and push address, and hooks.
        git(w.clone, "remote", "set-url", "origin", evil);
        git(w.clone, "remote", "set-url", "--push", "origin", evil);
        git(w.clone, "config", "core.hooksPath", hooks);
        const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
        const task = taskOf(await finish(engine, taskId), taskId);
        expect(task.error).toBeUndefined();
        expect(task.state).toBe(mode === "pull-request" ? "pr-open" : "done");
        const tested = git(task.worktree!, "rev-parse", "HEAD");
        expect(remoteRef(w.remote, mode === "pull-request" ? `refs/heads/${task.branch}` : "refs/heads/main")).toBe(tested);
        expect(git(w.dir, "--git-dir", evil, "for-each-ref")).toBe("");
        expect(remoteRef(w.remote, "refs/tags/planted")).toBeUndefined();
        expect(git(w.dir, "--git-dir", w.remote, "for-each-ref", "--format=%(refname)", "refs/tags")).toBe(mode === "release" ? "refs/tags/v0.1.0" : "");
        expect(hook.marks()).toEqual([]);
        expect(git(w.dir, "--git-dir", w.remote, "rev-parse", `${tested}:lib`)).toBe(unpushed);
        expect(libHas()).toBe(false);
        // The saved address stays what it was when the product was added.
        expect(engine.getState().products[0]!.remote).toBe(ADDRESS);
        // With the same settings, a plain push would have taken the submodule's commit along.
        const plain = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_CONFIG_")));
        execFileSync("git", ["-c", "core.hooksPath=/dev/null", "push", "-q", "--no-verify", w.remote, `${tested}:refs/heads/plain`], { cwd: w.clone, env: { ...plain, GIT_CONFIG_GLOBAL: globalConfig }, stdio: "pipe" });
        expect(libHas()).toBe(true);
      } finally {
        engine.shutdown();
        if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = before;
      }
    });
  }

  for (const mode of ["pull-request", "release"] as const) {
    it(`fetches and publishes a ${mode} over the SSH address saved when the product was added, not wherever origin points now`, async () => {
      const saved = "git@github.com:acme/demo.git";
      const w = world(`saved-${mode}`, { address: saved });
      const evil = join(w.dir, "evil.git");
      git(w.dir, "init", "-q", "--bare", "-b", "main", evil);
      // The coordinator's own SSH setup: an ssh that serves the folder standing in for GitHub and notes what it was asked for.
      const asked = join(w.dir, "ssh.log");
      const ssh = join(w.dir, "ssh.sh");
      writeFileSync(
        ssh,
        `#!/bin/sh\n[ "$1" = "-G" ] && exit 1\nfor arg; do host="$cmd"; cmd="$arg"; done\necho "$host $cmd" >> '${asked}'\ncase "$cmd" in\n  git-upload-pack*) exec git-upload-pack '${w.remote}' ;;\n  git-receive-pack*) exec git-receive-pack '${w.remote}' ;;\nesac\nexit 1\n`,
      );
      chmodSync(ssh, 0o755);
      const before = process.env.GIT_SSH_COMMAND;
      process.env.GIT_SSH_COMMAND = ssh;
      // No stand-in address through the constructor: Petrina connects to the product's saved address.
      const engine = new Engine(w.data, { agentCommand: () => [process.execPath, FAKE_AGENT, `--script=${join(w.dir, "shipper.json")}`], gh: [process.execPath, FAKE_GH, join(w.dir, "github.json"), w.remote] });
      try {
        const productId = await engine.addProduct(w.clone);
        engine.setProductDelivery(productId, mode, false);
        expect(engine.getState().products[0]!.remote).toBe(saved);
        git(w.clone, "remote", "set-url", "origin", evil);
        git(w.clone, "remote", "set-url", "--push", "origin", evil);
        const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
        const task = taskOf(await finish(engine, taskId), taskId);
        expect(task.error).toBeUndefined();
        expect(task.state).toBe(mode === "pull-request" ? "pr-open" : "done");
        const tested = git(task.worktree!, "rev-parse", "HEAD");
        expect(remoteRef(w.remote, mode === "pull-request" ? `refs/heads/${task.branch}` : "refs/tags/v0.1.0")).toBe(tested);
        expect(git(w.dir, "--git-dir", evil, "for-each-ref")).toBe("");
        // Every fetch and push went to the saved address, and both happened.
        const calls = readFileSync(asked, "utf8").trim().split("\n");
        expect([...new Set(calls)].sort()).toEqual(["git@github.com git-receive-pack 'acme/demo.git'", "git@github.com git-upload-pack 'acme/demo.git'"]);
      } finally {
        engine.shutdown();
        if (before === undefined) delete process.env.GIT_SSH_COMMAND;
        else process.env.GIT_SSH_COMMAND = before;
      }
    });
  }

  it("runs a product's credentialed git steps one at a time, task-start updates included", async () => {
    const w = world("serial");
    let open = 0;
    let most = 0;
    let total = 0;
    // GitHub standing in as a server that holds each connection a moment, then hangs up.
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          open += 1;
          total += 1;
          most = Math.max(most, open);
          setTimeout(() => socket.end(), 300);
        },
        close() {
          open -= 1;
        },
        data() {},
      },
    });
    const engine = new Engine(w.data, { agentCommand: () => [process.execPath, FAKE_AGENT], gh: [process.execPath, FAKE_GH, join(w.dir, "github.json"), w.remote], remote: `https://127.0.0.1:${server.port}/acme/demo.git` });
    try {
      const productId = await engine.addProduct(w.clone);
      engine.setPoolPaused(true);
      const tasks = [1, 2, 3].map((n) => engine.addTask({ productId, title: `Task ${n}`, description: "A greeting file. [quick]" }));
      engine.setPoolPaused(false);
      await until(engine, (state) => tasks.every((id) => taskOf(state, id).timeline.some((entry) => entry.text.startsWith("Did not update from GitHub"))), coordinator([]));
      expect(total).toBeGreaterThanOrEqual(3);
      expect(most).toBe(1);
      for (const id of tasks) engine.cancel(id);
    } finally {
      engine.shutdown();
      server.stop(true);
    }
  });
});

describe.concurrent("Products added before Petrina kept their GitHub address", () => {
  const forget = (w: World) =>
    w.editSaved((state) => {
      delete (state.products[0] as { remote?: string }).remote;
    });

  it("shows the current address once, keeps the answer, and then fetches and publishes there", async () => {
    const w = world("confirm");
    let engine = w.start();
    const productId = await engine.addProduct(w.clone);
    engine.setProductDelivery(productId, "pull-request", false);
    engine.shutdown();
    forget(w);
    engine = w.start();
    try {
      expect(engine.getState().products[0]!.remote).toBeUndefined();
      engine.setPoolPaused(true);
      const first = engine.addTask({ productId, title: "First", description: "A greeting file. [quick]" });
      const second = engine.addTask({ productId, title: "Second", description: "A greeting file. [quick]" });
      engine.setPoolPaused(false);
      const asked = (state: State) => state.inbox.filter((item) => item.kind === "question" && item.title.startsWith(`Is ${ADDRESS} the GitHub address`));
      let state = await until(engine, (current) => asked(current).length > 0, coordinator([]));
      await Bun.sleep(300);
      state = engine.getState();
      expect(asked(state)).toHaveLength(1);
      expect(asked(state)[0]!.options?.[0]).toBe("Yes, use this address");
      engine.answer(asked(state)[0]!.id, "Yes, use this address");
      await until(engine, (current) => current.products[0]!.remote === ADDRESS, coordinator([]));
      const done = taskOf(await finish(engine, first), first);
      expect(done.state).toBe("pr-open");
      await finish(engine, second);
      expect(engine.getState().inbox.some((item) => item.title.startsWith("Is "))).toBe(false);
    } finally {
      engine.shutdown();
    }
  });

  it("stops credentialed work after a No, and still delivers locally", async () => {
    const w = world("refuse");
    let engine = w.start();
    const productId = await engine.addProduct(w.clone);
    engine.setProductDelivery(productId, "pull-request", false);
    engine.shutdown();
    forget(w);
    engine = w.start();
    try {
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      const refuse = (current: Engine, state: State) => {
        for (const item of state.inbox) if (item.kind === "question" && item.title.startsWith("Is ")) current.answer(item.id, "No, it is not");
        coordinator()(current, state);
      };
      let task = taskOf(await finish(engine, taskId, refuse), taskId);
      expect(task.state).toBe("failed");
      expect(task.error).toContain(`you said ${ADDRESS} is not Clone's GitHub address`);
      expect(engine.getState().products[0]!.remoteRefused).toBe(ADDRESS);
      expect(w.github().calls).toEqual([]);
      expect(remoteRef(w.remote, `refs/heads/${task.branch}`)).toBeUndefined();

      const local = engine.addTask({ productId, title: "Add a local greeting", description: "A greeting file. [quick]", delivery: "local", approveDelivery: false });
      task = taskOf(await finish(engine, local), local);
      expect(task.state).toBe("done");
      expect(git(w.clone, "rev-parse", "main")).toBe(git(task.worktree!, "rev-parse", "HEAD"));
    } finally {
      engine.shutdown();
    }
  });

  it("publishes nothing when the saved address is not the product's repository", async () => {
    const w = world("mismatch");
    let engine = w.start();
    const productId = await engine.addProduct(w.clone);
    engine.setProductDelivery(productId, "pull-request", false);
    engine.shutdown();
    w.editSaved((state) => ((state.products[0] as { remote?: string }).remote = "git@github.com:evil/demo.git"));
    engine = w.start();
    try {
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("failed");
      expect(task.error).toContain("Clone's address git@github.com:evil/demo.git is not acme/demo on GitHub");
      expect(w.github().calls).toEqual([]);
      expect(existsSync(join(w.remote, "refs", "heads", task.branch!))).toBe(false);
      expect(itemOf(engine.getState(), taskId, "stuck")).toBeDefined();
    } finally {
      engine.shutdown();
    }
  });
});
