import { afterAll, describe, expect, it } from "bun:test";

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { waitFor } from "@petrina/test-support/fixtures";

import { sessionState } from "@petrina/agent-runtime/terminal";
import { takeoverFixtures, takeoverDir, heldLauncherCleanup } from "../../fixtures/takeover.js";
import { childState } from "@petrina/platform/process-tree";
import { processAlive } from "../../../src/instance.js";

const fixtures = takeoverFixtures(), start = fixtures.start;
afterAll(() => fixtures.close());
const posix = process.platform !== "win32";

describe.skipIf(!posix)("take over a builder in the terminal, then hand back", () => {
  it("lets the fake terminal app exit when its test worker is gone", async () => {
    const control = await heldLauncherCleanup();
    const observed: { pid: number; state: string }[] = [];
    let run: Awaited<ReturnType<typeof start>> | undefined, closing: Promise<void> | undefined;
    try {
      run = await start({ planner: "short", builder: "work", reopen: "resume" }, "", {
        launcherEnv: control.launcherEnv,
        observeLauncher(pid, state) { observed.push({ pid, state }); },
      });
      const current = run;
      await waitFor(() => current.fakes.marked("builder-working"), "the builder to draft");
      await run.working("builder");
      const hold = join(run.root, "hold");
      writeFileSync(hold, "");
      run.cli({ hold });
      const opened = await run.engine().takeOver(run.taskId);
      expect(opened.problem).toBeUndefined();
      const actor = await waitFor(() => current.actorRecords().find(actor => actor.kind === "cli" && actor.state === "running"), "the independently leased fake CLI to run");
      expect(processAlive(actor.pid)).toBe(true);
      const launcher = await waitFor(() => current.launcherRecords()[0], "the actual native launcher identity before lease loss");
      expect(await childState(launcher.childPid)).toBe("running");
      await run.closeTerminal();
      const ended = await waitFor(() => current.actorRecords().find(record => record.id === actor.id && record.pid === actor.pid && record.state === "ended")
        && !processAlive(actor.pid) && current.actorRecords().find(record => record.id === actor.id), "the actual leased fake CLI to exit, not just write an exit receipt");
      expect(ended).toMatchObject({ id: actor.id, pid: actor.pid, state: "ended", code: 78 });
      await waitFor(() => control.ready(), "actual rm to remove the launcher record and hold its parent shell");
      await waitFor(async () => (await sessionState(takeoverDir(current.data, current.taskId))) === "ended", "the orphaned fake app to close");
      expect(await childState(launcher.childPid)).toBe("running");
      let settled = false;
      closing = run.close();
      void closing.then(() => { settled = true; }, () => { settled = true; });
      await waitFor(() => observed.find(row => row.pid === launcher.childPid && row.state === "running"), "cleanup to observe the still-live native launcher", undefined, { during: closing });
      expect(existsSync(run.root)).toBe(true);
      expect(settled).toBe(false);
      control.release();
      await closing;
      expect(await childState(launcher.childPid)).toBe("ended");
      expect(existsSync(run.root)).toBe(false);
    } finally {
      // This lease/gate is independent: fixture.close cannot release it and make the pending proof vacuous.
      const releaseErrors: unknown[] = [];
      try { control.release(); } catch (error) { releaseErrors.push(error); }
      const stopped = await Promise.allSettled([...(run ? [closing ?? run.close()] : []), control.close()]);
      const errors = [...releaseErrors, ...stopped.flatMap(result => result.status === "rejected" ? [result.reason] : [])];
      if (errors.length) throw new AggregateError(errors, "The launcher completion counterexample could not clean up");
    }
  });
});
