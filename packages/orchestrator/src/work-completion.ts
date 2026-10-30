import { hasAcceptanceVersionConsumers } from "@petrina/core";
import type { RepositoryContext } from "./repository-context.js";
import type { WorkCompletionHost, WorkCompletionInput } from "./ports/work-completion.js";

/** Complete a consumed do-stage; native work and accepted result application precede this owner. */
export class WorkCompletion {
  constructor(private readonly host: WorkCompletionHost) {}

  async complete(scope: RepositoryContext, input: WorkCompletionInput): Promise<"continue"> {
    const { task, work: repository } = scope;
    this.host.finishStep(scope);
    this.host.endStage(scope);
    if (this.host.rerun(task)) return "continue";
    if (task.repositories && input.canEdit) {
      if (hasAcceptanceVersionConsumers(task)) await this.host.invalidateAcceptance(scope, input.testedVersions);
      const own = task.repositories.find((work) => work.productId === repository.productId)!;
      if (!task.repair) own.completedStages = [...new Set([...own.completedStages, input.stageId])];
      if (task.repair) {
        task.repair.index += 1;
        if (task.repair.index < task.repair.products.length) {
          const next = task.repair.products[task.repair.index]!;
          task.activeProductId = next;
          task.fixing = !task.repair.portProducts?.includes(next);
          this.host.checkpoint();
          return "continue";
        }
        // A repair of final testing goes back to it; an earlier one is checked by ordinary acceptance testing.
        if (task.repair.kind === "acceptance" && task.repair.final) task.retest = true;
        else if (task.repair.kind === "acceptance") task.repairCheck = true;
        task.stageIndex = task.repair.returnStage;
        delete task.repair;
        task.sub = 0;
        this.host.checkpoint();
        return "continue";
      }
      const next = task.repositories.find((work) => !work.completedStages.includes(input.stageId));
      if (next) {
        task.activeProductId = next.productId;
        this.host.checkpoint();
        return "continue";
      }
    }
    task.stageIndex += 1;
    task.sub = 0;
    this.host.changed();
    return "continue";
  }
}
