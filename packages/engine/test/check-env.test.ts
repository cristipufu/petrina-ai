// Petrina runs this suite with git settings that turn origin pushes off. The tests' own git
// commands still have to reach the repositories they create.
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir, runChecks, runCommand } from "./fixtures.js";
import { withoutCredentials } from "@petrina/platform/process-environment";

describe("git commands while Petrina runs the suite", () => {
  it("starts an isolated test engine from a restarted engine's check environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "petrina-check-restart-"));
    const live = Bun.serve({ port: 0, fetch: () => new Response("live engine") });
    const script = `
      const { EngineProcess, Fakes } = await import(${JSON.stringify(join(import.meta.dir, "support.ts"))});
      const { join } = await import("node:path");
      const root = process.argv[1];
      const fakes = new Fakes(join(root, "fakes")); fakes.scenario({});
      const engine = await EngineProcess.harness(join(root, "home"), fakes.dir);
      try {
        if (engine.hello.type !== "ready") throw new Error(engine.hello.message ?? "not ready");
        if (process.env.PETRINA_RECONNECT_PORT || process.env.PETRINA_LIFECYCLE_REPLACEMENT) throw new Error("Engine restart settings leaked");
      } finally { await engine.quit(); }
    `;
    try {
      const inherited = { ...process.env, PETRINA_LIFECYCLE_REPLACEMENT: "1", PETRINA_RECONNECT_PORT: String(live.port) };
      const env = { ...withoutCredentials(inherited, join(root, "empty-gh")), CI: "1", BROWSER: "none", PETRINA_AGENT: "1" };
      const [result] = await runChecks(root, [{ name: "Nested engine", argv: [process.execPath, "-e", script, root] }], env);
      expect(result!.ok, result!.output).toBe(true);
      expect(await (await fetch(`http://127.0.0.1:${live.port}`)).text()).toBe("live engine");
      expect(inherited.PETRINA_RECONNECT_PORT).toBe(String(live.port));
    } finally { live.stop(true); removeDir(root); }
  });

  it("can push to origin when the check environment disables those pushes", async () => {
    const root = mkdtempSync(join(tmpdir(), "petrina-check-git-"));
    const support = join(import.meta.dir, "support.ts");
    const script = `
      const { git } = await import(${JSON.stringify(support)});
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const root = process.env.PETRINA_GIT_PROBE;
      const remote = join(root, "origin.git");
      const repo = join(root, "repo");
      mkdirSync(repo, { recursive: true });
      await git(root, "init", "-q", "--bare", "-b", "main", remote);
      await git(repo, "init", "-q", "-b", "main");
      await git(repo, "config", "user.email", "t@example.com");
      await git(repo, "config", "user.name", "Test");
      writeFileSync(join(repo, "README.md"), "hi\\n");
      await git(repo, "add", ".");
      await git(repo, "commit", "-q", "-m", "init");
      await git(repo, "remote", "add", "origin", remote);
      await git(repo, "push", "-q", "origin", "main");
    `;
    try {
      const result = await runCommand([process.execPath, "-e", script], {
        env: {
          ...process.env,
          PETRINA_GIT_PROBE: root,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "remote.origin.pushurl",
          GIT_CONFIG_VALUE_0: "petrina-push-disabled://only-petrina-publishes",
          GIT_SSH_COMMAND: "petrina-ssh-disabled",
        },
      });
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    } finally {
      removeDir(root);
    }
  });
});
