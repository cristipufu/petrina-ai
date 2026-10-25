import { describe, expect, it } from "bun:test";
import { agentEnv } from "@petrina/platform/process-environment";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@petrina/test-support/commands";
import { writeGitProgram } from "@petrina/test-support/git-program";

describe("agent safety", () => {
it("never runs a password program: a missing login fails at once, a saved one still answers", async () => {
    const home = mkdtempSync(join(tmpdir(), "petrina-askpass-"));
    const askpass = join(home, "askpass");
    writeGitProgram(askpass, "exit 0");
    try {
      const config = join(home, "gitconfig");
      writeFileSync(config, `[core]\n\taskPass = ${JSON.stringify(askpass)}\n`);
      const own = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
      const fill = (env: NodeJS.ProcessEnv) => runCommand(["git", "credential", "fill"], { cwd: home, env, input: "protocol=https\nhost=example.invalid\n\n" });
      // Without Petrina's settings git asks the password program, from git's settings or from the environment.
      for (const env of [own, { ...own, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass }]) {
        expect((await fill(env)).stdout).toContain("password=");
        const agent = await fill(agentEnv(env));
        expect(agent.code).not.toBe(0);
        expect(agent.stdout).not.toContain("password=");
        expect(agent.stderr).toContain("terminal prompts disabled");
      }
      // A saved login, through the coordinator's credential helper, still works.
      writeFileSync(config, `[core]\n\taskPass = ${JSON.stringify(askpass)}\n[credential]\n\thelper = "!f() { echo username=me; echo password=saved; }; f"\n`);
      const saved = await fill(agentEnv(own));
      expect(saved.code).toBe(0);
      expect(saved.stdout).toContain("password=saved");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
