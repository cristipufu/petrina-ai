import { describe, expect, it } from "bun:test";
import { loginShellPath } from "@petrina/platform/login-shell";

describe("the PATH an app opened from the Dock gets", () => {
it.skipIf(process.platform === "win32")("asks the login shell", async () => {
    const path = await loginShellPath({ ...process.env, SHELL: "/bin/sh" });
    expect(path?.split(":").length).toBeGreaterThan(0);
  });
});
