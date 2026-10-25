import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promptApplication } from "./prompt-application.js";
import { checkCommand } from "./check-command.js";
import { git } from "../fixtures.js";

/** Inspect actual version-bound check evidence without planning, review, acceptance or delivery. */
export async function checkContext(root: string) {
  const f = await promptApplication(root);
  try {
    const { worktree } = f.scope.work;
    writeFileSync(join(worktree!, "greeting.txt"), "Hello\n");
    await git(worktree!, "add", "greeting.txt");
    await git(worktree!, "commit", "-q", "-m", "Add the greeting");
    const check = checkCommand(root);
    const productId = f.scope.work.productId;
    const setCheck = (...args: string[]) => f.engine.setProductChecks(productId, [{ name: "Welcome", command: check.command(...args) }]);
    return { ...f, ...check, productId, taskId: f.task.id, setCheck,
      check: async () => {
        const signal = new AbortController().signal;
        const definitions = await f.engine["checks"].ensureChecks(f.scope, signal);
        return f.engine["checks"].failing(f.scope, signal, definitions);
      },
    };
  } catch (error) { await f.engine.shutdown(); throw error; }
}
