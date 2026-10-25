import { afterAll, describe, expect, it } from "bun:test";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { runCommand } from "@petrina/test-support/commands";
import { makeProduct } from "@petrina/test-support/repositories";

const root = tempDir("petrina-test-git-env-");
afterAll(() => removeDir(root));
describe("Git commands in the test harness", () => {
  it("do not inherit Petrina's push protections", async () => {
    const clone = await makeProduct(root);
    const support = import.meta.resolve("@petrina/test-support/commands");
    const script = `
      const { git } = await import(${JSON.stringify(support)});
      // Exercise the public helper's default environment, not an explicitly sanitized override.
      console.log(JSON.stringify(await git(process.env.PETRINA_GIT_PROBE_CLONE, "push", "-q", "origin", "main")));
    `;
    const result = await runCommand([process.execPath, "-e", script], {
      env: {
        ...process.env,
        PETRINA_GIT_PROBE_CLONE: clone,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "remote.origin.pushurl",
        GIT_CONFIG_VALUE_0: "petrina-push-disabled://only-petrina-publishes",
      },
    });
    if (result.code !== 0) throw new Error(`The private Git fixture failed (${result.code}): ${result.stdout}\n${result.stderr}`);
    expect(JSON.parse(result.stdout)).toBe("");
  });
});
