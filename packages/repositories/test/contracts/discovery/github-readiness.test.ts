import { describe, afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { checkGh } from "@petrina/repositories/tool-readiness";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";
import { githubReadiness } from "../../fixtures/github-readiness.js";

const temp = tempDir("petrina-gh-readiness-");
afterAll(() => removeDir(temp));
let serial = 0;
const fresh = (name: string) => join(temp, `${name}-${++serial}`);
const LIMIT = 30_000 * SLOW;
describe("Tool status", () => {
it("reads the GitHub CLI's login and account", async () => {
    const fakes = githubReadiness(fresh("gh"));
    const gh = fakes.command;
    expect(await checkGh(gh, LIMIT)).toEqual({ status: "ready", account: "octocat" });
    fakes.github((state) => (state.loggedOut = true));
    expect((await checkGh(gh, LIMIT)).status).toBe("logged-out");
    fakes.github((state) => {
      state.loggedOut = false;
      state.offline = true;
    });
    expect((await checkGh(gh, LIMIT)).status).toBe("unknown");
    expect((await checkGh([join(temp, "no-such-gh")])).status).toBe("not-installed");
  });
});
