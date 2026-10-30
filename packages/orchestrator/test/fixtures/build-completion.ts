import { beginAgentStep, BUILT_IN_ROLES, builderFindings, type DeepMutable, type Finding } from "@petrina/core";
import { BuildCompletion } from "../../src/build-completion.js";
import type { BuildCompletionEffects, BuildCompletionInput, BuildReply } from "../../src/ports/build-completion.js";
import { executionFor } from "../../src/repository-context.js";
import type { RuntimeTask } from "../../src/model.js";
import { repairTask } from "./tasks.js";

type Effect = keyof BuildCompletionEffects;
type Observation = { [K in Effect]: { kind: K; value: Awaited<ReturnType<BuildCompletionEffects[K]>> | Error } }[Effect];
export const oldTree = "a".repeat(40), newTree = "b".repeat(40), buildHead = "c".repeat(40);

/** Accepted replies and operation-scoped repository observations; no native execution is represented. */
export function buildCompletionFixture(task: RuntimeTask = repairTask(false), clock?: () => number) {
  const scope = executionFor(task), calls: string[] = [], notes: string[] = [], checkpoints: RuntimeTask[] = [];
  const observations: Observation[] = [];
  const unexpected: string[] = [];
  let at = 1000;
  const now = clock ?? (() => ++at);
  const bound = (current: typeof scope) => {
    if (current.task !== task || current.work !== scope.work) throw new Error("Unexpected Builder completion owner");
  };
  async function take<K extends Effect>(kind: K, current: typeof scope): Promise<Awaited<ReturnType<BuildCompletionEffects[K]>>> {
    bound(current); calls.push(kind);
    const next = observations.shift();
    if (!next || next.kind !== kind) { unexpected.push(kind); throw new Error(`Unexpected Builder ${kind}; next observation ${next?.kind}`); }
    if (next.value instanceof Error) throw next.value;
    return next.value as Awaited<ReturnType<BuildCompletionEffects[K]>>;
  }
  const controller = new BuildCompletion({
    now, checkpoint: current => { if (current !== task) throw new Error("Wrong checkpoint owner"); checkpoints.push(structuredClone(task)); },
    note: (current, _tone, words) => { bound(current); notes.push(words); },
    noteLearnings: async (current, lessons) => { bound(current); calls.push("learnings"); if (lessons.length) throw new Error("No learning effect was declared"); },
  }, {
    saveChanges: current => take("saveChanges", current),
    finishPort: current => take("finishPort", current),
    fold: current => take("fold", current), tree: current => take("tree", current),
    versions: current => { if (current !== task) throw new Error("Wrong proof owner"); return take("versions", scope); },
    repairVersion: current => take("repairVersion", current),
  });
  function begin(reply: Partial<BuildReply> = {}, options: Partial<Omit<BuildCompletionInput, "result">> = {}) {
    task.stageIndex = task.plan!.stages.findIndex(stage => stage.roleId === "builder");
    const given: DeepMutable<Finding>[] = task.fixing ? builderFindings(task, scope.work.productId) : [];
    const input: BuildCompletionInput = { stageId: "build", roleId: "builder", plannedProfileId: "builder", actualProfileId: "actual-builder", sourceName: "main",
      startingTree: oldTree, given, checkFailures: [], maintenance: false,
      result: { summary: "Returned the declared work", changes: [], answers: [], learnings: [], ...reply }, ...options };
    const step = beginAgentStep(task, input.roleId, input.actualProfileId, now(), BUILT_IN_ROLES, undefined, scope.work);
    step.findingIds = given.map(finding => finding.id);
    step.agentResults = [{ roleId: input.roleId, profileId: input.actualProfileId, at: now(), value: input.result }];
    return { input, step, run: () => controller.complete(scope, input) };
  }
  return { task, scope, controller, calls, notes, observations, checkpoints, now, begin,
    observe(...values: Observation[]) { observations.push(...values); },
    saved(tree: string | undefined = newTree) { observations.push({ kind: "saveChanges", value: undefined }, { kind: "fold", value: undefined }, { kind: "tree", value: tree }); },
    consumed() { if (unexpected.length) throw new Error(`Unexpected Builder effects: ${unexpected.join(", ")}`); if (observations.length) throw new Error(`Unconsumed Builder observations: ${observations.map(row => row.kind).join(", ")}`); },
  };
}
