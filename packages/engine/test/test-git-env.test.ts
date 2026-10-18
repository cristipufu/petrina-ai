import { afterAll, describe, expect, it } from "bun:test";
import { removeDir, git, makeProduct, tempDir } from "./support.js";

const root = tempDir("petrina-test-git-env-");
afterAll(() => removeDir(root));

describe("Git commands in the test harness", () => {
  it("do not inherit Petrina's push protections", () => {
    const clone = makeProduct(root);
    const names = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
    const before = names.map((name) => process.env[name]);
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "remote.origin.pushurl";
    process.env.GIT_CONFIG_VALUE_0 = "petrina-push-disabled://only-petrina-publishes";
    try {
      // This is the same Git child path used by delivery tests. Without an explicit sanitized
      // env, Git sees the injected push URL and rejects the fixture's ordinary local push.
      expect(() => git(clone, "push", "-q", "origin", "main")).not.toThrow();
    } finally {
      names.forEach((name, index) => {
        const value = before[index];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
  });
});
