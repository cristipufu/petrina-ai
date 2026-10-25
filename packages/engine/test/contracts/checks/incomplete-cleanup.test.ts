import { describe as originalDescribe } from "bun:test";
import { afterAll, expect, it } from "bun:test";


import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { commandText } from "../../../src/checks.js";

import { CLEANUP_INCOMPLETE } from "@petrina/platform/process-tree";

import { Store } from "@petrina/storage/store";
import { EngineProcess, Fakes, HARNESS, makeProduct, removeDir, tempDir, waitFor } from "../../support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
// Check behavior and cleanup limits do not depend on the host's power-log read: the fixtures' check runs and
// engines supply no records. Evidence cases pass their own; the native reader's contract lives in check-interruption.test.ts.


originalDescribe("a stopped check keeps an incomplete cleanup warning", () => {
for (const kind of ["check", "hook"] as const) {
    it.skipIf(process.platform === "win32")(`saves it when cancelling a ${kind} cannot list the programs it started`, async () => {
      const dir = tempDir("petrina-check-stop-warn-");
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
      writeFileSync(worker, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(childPid)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
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
      try {
        engine = await EngineProcess.start(home, [launcher, home, fakes.dir]);
        const productId = await engine.act("addProduct", repo) as string;
        await engine.act("setProductChecks", productId, [{ name: "Detached", command: commandText([process.execPath, parent]) }]);
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
      } finally {
        if (engine?.proc.exitCode === null) await engine.quit().catch(() => engine!.kill());
        try { process.kill(Number(readFileSync(childPid, "utf8")), "SIGKILL"); } catch { /* Already gone. */ }
        removeDir(dir);
      }
    });
  }
});
