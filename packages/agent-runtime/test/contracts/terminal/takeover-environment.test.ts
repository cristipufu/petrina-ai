import { expect, it } from "bun:test";
import { takeoverEnvironmentFixture } from "../../fixtures/takeover-environment.js";

it.skipIf(process.platform === "win32")("launches the coordinator's real terminal with their login and without Petrina's variables", async () => {
  const owner = await takeoverEnvironmentFixture();
  try {
    const secret = "petrina-test-secret-value-1234";
    const opened = await owner.run({ ...process.env, PETRINA_TEST_SECRET: secret, GH_TOKEN_FOR_TEST: secret });
    expect(opened.env.filter((name) => name.startsWith("PETRINA_"))).toEqual([]);
    expect(opened.launcher).not.toContain(secret);
    expect(opened.loginRetained).toBe(true);
    expect(opened.problem).toBeUndefined();
    expect(opened.code).toBe(0);
  } finally { await owner.close(); }
});
