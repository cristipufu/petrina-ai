import { afterEach } from "bun:test";
import { engineProcessCases } from "../../support.js";
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks } from "../../fixtures.js";
import { withoutCredentials } from "@petrina/platform/process-environment";

const cases = engineProcessCases();
afterEach(() => cases.close());

describe("git commands while Petrina runs the suite", () => {
it("starts an isolated test engine from a restarted engine's check environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "petrina-check-restart-"));
    const controller = new AbortController();
    let stopLive = () => {};
    return cases.use(root, async owners => {
    const live = Bun.serve({ port: 0, fetch: () => new Response("live engine") });
    stopLive = () => { live.stop(true); };
    const script = `
      const { nestedCheckEngine } = await import(${JSON.stringify(join(import.meta.dir, "../../fixtures/nested-check-engine.ts"))});
      await nestedCheckEngine(process.argv[1]);
    `;
    try {
      const inherited = { ...process.env, PETRINA_LIFECYCLE_REPLACEMENT: "1", PETRINA_RECONNECT_PORT: String(live.port) };
      const env = { ...withoutCredentials(inherited, join(root, "empty-gh")), CI: "1", BROWSER: "none", PETRINA_AGENT: "1" };
      const [result] = await runChecks(root, [{ name: "Nested engine", argv: [process.execPath, "-e", script, root] }], env, undefined, controller.signal, undefined, undefined, undefined, undefined, undefined, undefined, () => !owners.signal.aborted);
      expect(result!.ok, result!.output).toBe(true);
      expect(await (await fetch(`http://127.0.0.1:${live.port}`)).text()).toBe("live engine");
      expect(inherited.PETRINA_RECONNECT_PORT).toBe(String(live.port));
    } finally { live.stop(true); }
    }, { stopPeers() { controller.abort(); stopLive(); } });
  });
});
