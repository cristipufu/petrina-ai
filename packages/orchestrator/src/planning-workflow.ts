import { endAgentStep, JOURNEY_WORDS, normalizePlan, type DeepMutable, type Product, type Task } from "@petrina/core";
import type { RuntimeTask } from "./model.js";
import type { InputSection } from "./ports/participant-input.js";
import type {
  PlannerReply,
  PlanningWorkflowEffects,
  PlanningWorkflowHost,
} from "./ports/planning-workflow.js";
import { executionFor } from "./repository-context.js";
import { checkSourceHints } from "./source-hints.js";

function registeredProductsSection(products: readonly Product[], task: RuntimeTask): InputSection {
  const catalog = products
    .map((product) =>
      JSON.stringify({
        id: product.id,
        name: product.name,
        repo: product.repo,
        defaultBranch: product.defaultBranch ?? "main",
        existingLocalCopy: product.path,
      }),
    )
    .join("\n");
  const startGuidance = task.explicitStart
    ? "The starting point was explicitly chosen too."
    : "You may propose a starting point from the task words.";
  return {
    title: "Registered products and starting choices",
    body: `Registered products (use these exact ids, never a repo, wherever a product id is asked for; propose unregistered repositories explicitly with repo):\n${catalog}\nCurrent coordinator choices: ${JSON.stringify(task.selectedProducts ?? [task.workChoice])}. The selected product and delivery mode are authoritative. ${startGuidance} Changes require the coordinator’s confirmation. Return worksOn as the complete ordered product list. Retain every coordinator-selected product. For each entry give a reason and builderProfileId, and propose the leadProductId for shared repairs. You may search GitHub, including private dependencies, with the coordinator’s login. Never guess an engine action from task wording. Each structured choice has: productId, startFrom ({kind: default}, {kind: branch, name}, or {kind: pull-request, value: number or link as text}), delivery (pull-request, local, release). Unknown products must be named honestly; never substitute another product. Never fetch, clone, create a worktree or change existing local work.`,
  };
}

/** Portable planner stage progression: orientation selection, risk/source-pointer settlement and plan normalization. */
export class PlanningWorkflow {
  constructor(
    private readonly host: PlanningWorkflowHost,
    private readonly effects: PlanningWorkflowEffects,
  ) {}

  async runPlanner(task: RuntimeTask, signal: AbortSignal): Promise<void> {
    const scope = executionFor(task);
    const planner = this.host.onUsable(this.host.plannerProfileId);
    let actualPlanner = planner;
    const products = this.host.products();
    const selectedIds = new Set(
      (task.selectedProducts ?? [task.workChoice]).flatMap((choice) => (choice ? [choice.productId] : [])),
    );
    const selectedProducts = products.filter((product) => selectedIds.has(product.id)).slice(0, 4);
    const navigation = await this.effects.readOrientation(selectedProducts);
    signal.throwIfAborted();
    const result = await this.effects.runTurn(
      scope,
      {
        plannerProfileId: planner,
        requestedProfileId: this.host.plannerProfileId,
        ...(planner !== this.host.plannerProfileId
          ? { selectionReason: "The configured Planner tool was unavailable; selected an installed tool." }
          : {}),
        sections: () => [registeredProductsSection(this.host.products(), task), ...navigation],
        used: (id) => {
          actualPlanner = id;
        },
      },
      signal,
    );
    // Unrated work is treated as medium: never shipped unasked, never short of reviewers.
    const risk = result.risk ?? { level: "medium" as const, why: "The planner did not rate it." };
    task.risk = risk;
    await this.effects.proposeSources(task, result.worksOn);
    // Hints may name only the registered products Petrina resolved for this plan, by their exact ids.
    const currentProducts = this.host.products();
    const plannedIds = task.workRows?.map((row) => row.source?.product.id ?? row.choice.productId) ?? [
      (task.proposedSource ?? scope.work.source)?.product.id ?? task.workProposal?.[0]?.productId ?? task.productId,
    ];
    const hints = checkSourceHints(
      result.sourcePointers,
      plannedIds.filter((id) => currentProducts.some((product) => product.id === id)),
    );
    if (hints.pointers.length) {
      task.sourcePointers = hints.pointers;
    } else {
      delete task.sourcePointers;
    }
    if (hints.left) {
      this.host.note(task, "status", hints.left, "planner", actualPlanner);
    }
    task.plan = this.normalizePlan(task, result, actualPlanner);
    const count = task.plan.stages.filter((stage) => stage.kind !== "gate").length;
    this.host.note(task, "milestone", `Plan ready: ${count} stages. ${result.rationale}`, "planner", actualPlanner);
    this.host.note(
      task,
      "milestone",
      `${this.host.riskWord[risk.level]} risk: ${risk.why}`,
      "planner",
      actualPlanner,
    );
    endAgentStep(task, { outcome: JOURNEY_WORDS.planned(count), reason: JOURNEY_WORDS.planReady }, this.host.now());
    this.host.finishStep(task);
    this.host.endStage(task);
    this.host.changed();
  }

  normalizePlan(
    task: RuntimeTask,
    result: PlannerReply,
    plannerProfileId: Id,
  ): DeepMutable<NonNullable<Task["plan"]>> {
    const scope = executionFor(task);
    return normalizePlan({
      task: {
        ...task,
        ...(task.workRows ? { approveDelivery: true } : {}),
        source: task.proposedSource ?? scope.work.source,
        delivery: task.proposedSource?.destination.mode ?? task.delivery,
      },
      result: {
        ...result,
        ...(task.workRows ? { worksOn: task.workRows.map((row) => row.choice) } : {}),
      },
      roles: this.host.roles(),
      profiles: this.host.profiles(),
      plannerProfileId,
      releaseManagerProfileId: this.host.releaseManagerProfileId,
      onUsable: (id) => this.host.onUsable(id),
    }) as DeepMutable<NonNullable<Task["plan"]>>;
  }
}

type Id = string;
