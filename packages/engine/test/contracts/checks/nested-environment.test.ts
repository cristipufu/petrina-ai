import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "@petrina/test-support/fixtures";
import { runChecks } from "../../fixtures.js";
import { withoutCredentials } from "@petrina/platform/process-environment";

describe("git commands while Petrina runs the suite", () => {
it("starts an isolated test engine from a restarted engine's check environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "petrina-check-restart-"));
    const live = Bun.serve({ port: 0, fetch: () => new Response("live engine") });
    const script = `
      const { EngineProcess, Fakes } = await import(${JSON.stringify(join(import.meta.dir, "../../support.ts"))});
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
});
