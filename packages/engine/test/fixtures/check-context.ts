import type { EngineCaseOwner } from "./engine-cases.js";
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repositorySeed } from "@petrina/test-support/repositories";
import { commitChanges } from "@petrina/repositories/git";
import { promptApplication, type PromptApplication } from "./prompt-application.js";
import { checkCommand } from "./check-command.js";
import { tempDir } from "../fixtures.js";
import { installSharedWorkflowFastPaths } from "./shared-preparation.js";
import { executionFor } from "@petrina/orchestrator";

let greetingRepoSeed: Promise<string> | undefined;
function getGreetingRepoSeed(): Promise<string> {
  if (!greetingRepoSeed) {
    greetingRepoSeed = (async () => {
      const seed = await repositorySeed();
      const dir = join(tempDir("petrina-check-context-seed-"), "repo");
      cpSync(seed.clone, dir, { recursive: true });
      writeFileSync(join(dir, "greeting.txt"), "Hello\n");
      await commitChanges(dir, "Add the greeting");
      return dir;
    })();
  }
  return greetingRepoSeed;
}

/** Inspect actual version-bound check evidence without planning, review, acceptance or delivery. */
async function prepareCheckContext(owner: EngineCaseOwner, f: PromptApplication, options: { nativeGitCapture?: boolean } = {}) {
  const root = owner.root;
    let engine = f.engine, task = f.task;
    if (!options.nativeGitCapture) installSharedWorkflowFastPaths(engine, { fastCheckCapture: true });
    const { worktree } = f.scope.work;
    const preparedRepo = await getGreetingRepoSeed();
    owner.check();
    rmSync(worktree!, { recursive: true, force: true });
    cpSync(preparedRepo, worktree!, { recursive: true });
    owner.check();
    const check = checkCommand(root);
    engine.options.runCheckCommand = check.execute;
    const productId = f.scope.work.productId;
    const setCheck = (...args: string[]) => engine.setProductChecks(productId, [{ name: "Welcome", command: check.command(...args) }]);
    return { ...f, ...check, productId, taskId: task.id, setCheck,
      get engine() { return engine; }, get task() { return task; }, get scope() { return executionFor(task); },
      restart: () => owner.prepare(async () => {
        const previous = engine, state = task.state, taskId = task.id;
        // This adapter contract has no driver to resume; persist its evidence without admitting a workflow.
        task.state = "backlog";
        previous.commitNow(task);
        engine = await owner.restart(previous, previous.dataDir, previous.options);
        if (!options.nativeGitCapture) installSharedWorkflowFastPaths(engine, { fastCheckCapture: true });
        owner.check();
        engine.schedule = () => {};
        await engine.waitUntilReady();
        owner.check();
        task = engine.task(taskId)!;
        task.state = state;
        engine.setPoolPaused(false);
      }),
      check: () => {
        const controller = new AbortController();
        owner.onStop(() => controller.abort());
        const current = engine, scope = executionFor(task);
        return owner.run(current, async () => {
        const signal = controller.signal;
        const definitions = await current["checks"].ensureChecks(scope, signal);
        return current["checks"].failing(scope, signal, definitions);
      });
      },
    };
}

export function checkContext<T>(owner: EngineCaseOwner, body: (fixture: Awaited<ReturnType<typeof prepareCheckContext>>) => Promise<T>, options: { nativeGitCapture?: boolean } = {}): Promise<T> {
  return promptApplication(owner, undefined, async f => {
    const fixture = await prepareCheckContext(owner, f, options);
    owner.check();
    return body(fixture);
  });
}
