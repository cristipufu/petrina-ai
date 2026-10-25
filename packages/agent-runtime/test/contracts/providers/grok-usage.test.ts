import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { readGrokUsage } from "../../../src/grok-usage.js";
import { grokReports } from "../../../src/grok-report.js";
import { removeDir, waitFor } from "@petrina/test-support/fixtures";
import { server as fixtureServer } from "../../fixtures/grok-account.js";
import { billing } from "../../fixtures/grok-account-report.js";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
function server(plan: unknown) { const value = fixtureServer(plan); roots.push(value.dir); return value; }
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it("reads the installed CLI extension without creating a session or sending a prompt, then stops", async () => {
    const fake = server(billing());
    expect(await readGrokUsage({ command: fake.command, env: process.env })).toEqual(grokReports(billing()));
    expect(fake.asked().map(r => r.method)).toEqual(["initialize", "_x.ai/billing"]);
    await waitFor(() => !alive(fake.asked()[0]!.pid), "the account reader to stop", 5000);
  });

  it("stops an unresponsive CLI, and reports refusal and missing executables without an AI turn", async () => {
    const hanging = server({ hang: true, ignoreStop: true });
    let pid: number | undefined;
    await expectRejection(readGrokUsage({ command: hanging.command, env: process.env, timeoutMs: 500, onProcess: (child) => { pid = child.pid; } }), "in time");
    expect(pid).toBeGreaterThan(0);
    await waitFor(() => !alive(pid!), "the hanging Grok reader to stop", 5000);
    const refused = server({ error: "Authentication required" });
    await expectRejection(readGrokUsage({ command: refused.command, env: process.env }), "Authentication required");
    await expectRejection(readGrokUsage({ command: [join(refused.dir, "no-such-grok")], env: process.env }), "could not start");
  });
