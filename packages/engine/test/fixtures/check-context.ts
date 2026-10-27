import type { EngineCaseOwner } from "./engine-cases.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promptApplication, type PromptApplication } from "./prompt-application.js";
import { checkCommand } from "./check-command.js";
import { git } from "../fixtures.js";

/** Inspect actual version-bound check evidence without planning, review, acceptance or delivery. */
async function prepareCheckContext(owner: EngineCaseOwner, f: PromptApplication) {
  const root = owner.root;
    const { worktree } = f.scope.work;
    writeFileSync(join(worktree!, "greeting.txt"), "Hello\n");
    await git(worktree!, "add", "greeting.txt");
    owner.check();
    await git(worktree!, "commit", "-q", "-m", "Add the greeting");
    owner.check();
    const check = checkCommand(root);
    const productId = f.scope.work.productId;
    const setCheck = (...args: string[]) => f.engine.setProductChecks(productId, [{ name: "Welcome", command: check.command(...args) }]);
    return { ...f, ...check, productId, taskId: f.task.id, setCheck,
      check: () => {
        const controller = new AbortController();
        owner.onStop(() => controller.abort());
        return owner.run(f.engine, async () => {
        const signal = controller.signal;
        const definitions = await f.engine["checks"].ensureChecks(f.scope, signal);
        return f.engine["checks"].failing(f.scope, signal, definitions);
      });
      },
    };
}

export function checkContext<T>(owner: EngineCaseOwner, body: (fixture: Awaited<ReturnType<typeof prepareCheckContext>>) => Promise<T>): Promise<T> {
  return promptApplication(owner, undefined, async f => {
    const fixture = await prepareCheckContext(owner, f);
    owner.check();
    return body(fixture);
  });
}
