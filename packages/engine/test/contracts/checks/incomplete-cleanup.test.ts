import { afterEach } from "bun:test";
import { engineProcessCases } from "../../support.js";
import { createProcessLease, type ProcessLease } from "@petrina/test-support/process-lease";
import { childState } from "@petrina/platform/process-tree";
import { describe as originalDescribe } from "bun:test";
import { expect, it } from "bun:test";


import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { commandInputText } from "../../../src/checks.js";

import { CLEANUP_INCOMPLETE } from "@petrina/platform/process-tree";

import { Store } from "@petrina/storage/store";
import { EngineProcess, Fakes, HARNESS, makeProduct, tempDir, waitFor } from "../../support.js";

const cases = engineProcessCases();
afterEach(() => cases.close());

// Check behavior and cleanup limits do not depend on the host's power-log read: the fixtures' check runs and
// engines supply no records. Evidence cases pass their own; the native reader's contract lives in check-interruption.test.ts.


originalDescribe("a stopped check keeps an incomplete cleanup warning", () => {
for (const kind of ["check", "hook"] as const) {
    it.skipIf(process.platform === "win32")(`saves it when cancelling a ${kind} cannot list the programs it started`, async () => {
      const dir = tempDir("petrina-check-stop-warn-");
      let workerLease: ProcessLease | undefined;
      let stopWorker = async (): Promise<void> => {};
      return cases.use(dir, async owners => {
      const home = join(dir, "data");
      const fakes = new Fakes(join(dir, "fake"));
      fakes.scenario({ planner: "short", builder: "plain" });
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const blind = join(dir, "blind");
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      writeFileSync(join(bin, "ps"), `#!/bin/sh\nif [ -f ${quote(blind)} ]; then exit 1; fi\nexec /bin/ps "$@"\n`);
      chmodSync(join(bin, "ps"), 0o755);
      const worker = join(dir, "worker.ts");
      const childPid = join(dir, "child.pid");
      const ready = join(dir, "ready");
      workerLease = await createProcessLease();
      stopWorker = () => workerLease!.close();
      if (owners.signal.aborted) { await workerLease.close(); throw new Error("Detached-worker preparation was stopped"); }
      stopWorker = async () => {
        await workerLease!.close();
        if (existsSync(childPid)) {
          const pid = Number(readFileSync(childPid, "utf8"));
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("The private worker did not report a valid native process identity");
          await waitFor(async () => await childState(pid) === "ended", "the independently leased worker to report native ended state", 5_000);
        }
      };
      writeFileSync(worker, workerLease.program(`const { writeFixtureJson } = await import(${JSON.stringify(import.meta.resolve("@petrina/test-support/fixture-json"))});\nwriteFixtureJson(${JSON.stringify(childPid)}, process.pid);\nsetInterval(() => {}, 1000); await new Promise(() => undefined);\n`));
      const hang = `import { spawn } from "node:child_process";\nimport { existsSync, writeFileSync } from "node:fs";\nconst child = spawn(process.execPath, [${JSON.stringify(worker)}], { detached: true, stdio: "ignore" });\nchild.unref();\nwhile (!existsSync(${JSON.stringify(childPid)})) await Bun.sleep(20);\nwriteFileSync(${JSON.stringify(ready)}, "ready");\nsetInterval(() => {}, 1000);\n`;
      const parent = join(dir, kind === "check" ? "parent.ts" : "pass.ts");
      const hookScript = join(dir, "hook.ts");
      writeFileSync(parent, kind === "check" ? hang : "process.exit(0);\n");
      if (kind === "hook") writeFileSync(hookScript, hang);
      const repo = await makeProduct(dir);
      if (kind === "hook") {
        const hook = join(repo, ".git", "hooks", "pre-commit");
        writeFileSync(hook, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(hookScript)}\n`);
        chmodSync(hook, 0o755);
      }
      const launcher = join(dir, "engine.ts");
      writeFileSync(launcher, `process.env.PATH = ${JSON.stringify(bin)} + ":" + process.env.PATH;\nawait import(${JSON.stringify(HARNESS)});\n`);
      let engine: EngineProcess | undefined;
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

        engine = await owners.harness(home, fakes.dir, undefined, { entry: launcher });
        const productId = await engine.act("addProduct", repo) as string;
        await engine.act("setProductChecks", productId, [{ name: "Detached", command: commandInputText([process.execPath, parent]) }]);
        await engine.act("setProductDelivery", productId, "local", true);
        const id = await engine.act("addTask", { productId, title: "Add a greeting", description: "[no-check]" }) as string;
        await waitFor(async () => {
          const state = await engine!.state();
          for (const item of state.inbox) {
            if (item.kind === "plan" || item.kind === "design") await engine!.act("approve", item.id);
            else if (item.kind === "question") await engine!.act("answer", item.id, item.options?.[0] ?? "Yes");
            else if (item.kind === "permission") await engine!.act("allow", item.id, "once");
          }
          const task = state.tasks.find((entry) => entry.id === id);
          if (task?.state === "failed") throw new Error(task.error ?? task.statusLine);
          return existsSync(ready);
        }, `the ${kind} to start its detached program`, 90_000);
        const pid = Number(readFileSync(childPid, "utf8"));
        expect(alive(pid)).toBe(true);
        writeFileSync(blind, "");
        await engine.act("cancel", id);
        const state = await waitFor(async () => {
          const next = await engine!.state();
          const task = next.tasks.find((entry) => entry.id === id);
          return task?.checks?.results.some((run) => run.cleanupIncomplete) ? next : undefined;
        }, "the stopped run to keep its cleanup warning");
        const task = state.tasks.find((entry) => entry.id === id)!;
        const run = task.checks!.results.find((entry) => entry.cleanupIncomplete)!;
        expect(task.state).toBe("cancelled");
        expect(task.checks?.sha).toBeUndefined();
        expect(task.checks?.tree).toBeUndefined();
        expect(run.output).toContain(CLEANUP_INCOMPLETE);
        if (kind === "hook") expect(run.command).toContain("pre-commit");
        expect(task.timeline.some((entry) => entry.text === CLEANUP_INCOMPLETE)).toBe(true);
        expect(task.findings.some((finding) => finding.text.startsWith("Check failed"))).toBe(false);
        expect(alive(pid)).toBe(true);
        // Inspect durable evidence only after its writer has finished saving and released SQLite.
        await engine.quit();
        const store = new Store(join(home, "petrina.db"));
        try {
          const saved = store.load()!.tasks.find((entry) => entry.id === id)!;
          expect(saved.repository!.checks?.sha).toBeUndefined();
          expect(saved.repository!.checks?.tree).toBeUndefined();
          expect(saved.repository!.checks?.results.some((entry) => entry.cleanupIncomplete)).toBe(true);
          expect(saved.timeline.some((entry) => entry.text === CLEANUP_INCOMPLETE)).toBe(true);
        } finally { store.close(); }


      }, { stopPeers: () => stopWorker() });
    });
  }
});
