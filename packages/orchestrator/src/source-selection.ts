import { deliveryLabel, prNumber, workSummary, type WorkChoice } from "@petrina/core";
import { detachRepositoryState, executionFor } from "./repository-context.js";
import type { RuntimeTask } from "./model.js";
import type { SourceSelectionEffects, SourceSelectionHost } from "./ports/source.js";

export class SourceSelections {
  constructor(private readonly host: SourceSelectionHost, private readonly effects: SourceSelectionEffects) {}

  async propose(task: RuntimeTask, proposal: readonly WorkChoice[] | undefined, coordinator = false): Promise<void> {
    const scope = executionFor(task);
    const selected = task.selectedProducts ?? (task.workChoice?.productId ? [task.workChoice] : []);
    if (task.workRows || (proposal && selected.some((choice) => !proposal.some((entry) => entry.productId === choice.productId))) || selected.length > 1 || (proposal?.length ?? 0) > 1 || proposal?.some((choice) => choice.repo && !this.host.products().some((product) => product.id === choice.productId || product.repo.toLowerCase() === choice.repo?.toLowerCase()))) {
      return this.proposeMany(task, proposal ?? selected, coordinator);
    }
    // Tasks saved before starting choices existed already chose this product and its default branch.
    if (!task.workChoice && task.productId) task.workChoice = { productId: task.productId, startFrom: { kind: "default" }, delivery: task.delivery };
    const choices = proposal ?? (task.workChoice ? [task.workChoice] : []);
    const pendingProposal = [...choices];
    task.workProposal = pendingProposal;
    task.workError = "Checking the product and starting point with GitHub…";
    task.confirmWork = true;
    delete task.proposedSource;
    if (choices.length !== 1) {
      task.workError = choices.length > 1 ? "This plan involves several products. Choose one product for this task; multi-product tasks are a separate feature." : "Choose one registered product and its starting point.";
      task.confirmWork = true;
      task.workValidating = false;
      this.host.commitNow(task);
      return;
    }
    const choice = choices[0]!;
    const current = () => task.workProposal === pendingProposal && !task.workRows;
    task.workValidating = true;
    try {
      this.host.commitNow(task);
      const resolved = await this.effects.resolve(task, choice);
      if (!current()) return;
      delete task.workError;
      const original = task.workChoice;
      // Compare resolved identities too: a PR number and its link are the same choice.
      let unchanged = original?.productId === choice.productId && original.delivery === choice.delivery && JSON.stringify(original.startFrom) === JSON.stringify(choice.startFrom);
      if (!unchanged && original?.productId === choice.productId && original.delivery === choice.delivery && original.startFrom.kind === "pull-request" && choice.startFrom.kind === "pull-request") {
        // A rejected old link must not prevent the coordinator from correcting it.
        try { unchanged = prNumber(original.startFrom.value, resolved.product.repo) === prNumber(choice.startFrom.value, resolved.product.repo); } catch { unchanged = false; }
      }
      if (scope.work.source?.confirmed && (JSON.stringify(scope.work.source.start) !== JSON.stringify(resolved.start) || JSON.stringify(scope.work.source.destination) !== JSON.stringify(resolved.destination))) unchanged = false;
      if (unchanged && task.productId && (resolved.start.kind !== "pull-request" || scope.work.source?.confirmed)) {
        scope.work.source = { ...resolved, confirmed: true, ...(scope.work.source?.initialSha ? { initialSha: scope.work.source.initialSha } : {}) };
        task.confirmWork = false;
      } else {
        task.proposedSource = resolved;
        task.confirmWork = true;
      }
    } catch (error) {
      if (!current()) return;
      task.workError = error instanceof Error ? error.message : String(error);
      task.confirmWork = true;
    } finally {
      if (current()) task.workValidating = false;
    }
    const source = task.proposedSource ?? scope.work.source;
    if (source) for (const stage of task.plan?.stages ?? []) if (stage.kind === "do" && this.host.role(stage.roleId, task)?.result === "delivery") stage.title = deliveryLabel({ source, delivery: source.destination.mode });
    const item = this.host.planCheck(task.id);
    if (item) item.body = [task.proposedSource ?? scope.work.source ? workSummary((task.proposedSource ?? scope.work.source)!) : "", task.workError ?? ""].filter(Boolean).join("\n");
    this.host.commitNow(task);
  }

  private async proposeMany(task: RuntimeTask, proposal: readonly WorkChoice[], coordinator: boolean): Promise<void> {
    task.workValidating = true;
    task.workError = "Checking every product and starting point with GitHub…";
    this.host.commitNow(task);
    const prior = task.workRows;
    const selected = task.selectedProducts ?? [];
    const choices = proposal.map((choice) => {
      const product = this.host.products().find((entry) => entry.id === choice.productId) ?? this.host.products().find((entry) => entry.repo.toLowerCase() === (choice.repo ?? choice.productId).toLowerCase());
      return product ? { ...choice, productId: product.id, repo: product.repo } : choice;
    });
    if (!coordinator) for (const choice of selected) if (!choices.some((entry) => entry.productId === choice.productId)) choices.push(choice);
    task.workProposal = [...proposal];
    task.confirmWork = true;
    task.approvePlan = true;
    const rows = choices.map((raw) => {
      const product = this.host.products().find((entry) => entry.id === raw.productId || (raw.repo && entry.repo.toLowerCase() === raw.repo.toLowerCase()));
      const choice = { ...raw, ...(product ? { productId: product.id, repo: product.repo } : {}) };
      const earlier = selected.find((entry) => entry.productId === choice.productId);
      const saved = prior?.find((row) => row.choice.productId === choice.productId && row.choice.repo === choice.repo);
      const row: NonNullable<RuntimeTask["workRows"]>[number] = { choice, ...(saved?.addition ? { addition: saved.addition, source: saved.source } : {}) };
      if (!coordinator) {
        if (!proposal.some((entry) => entry.productId === choice.productId) && earlier) row.change = "omitted";
        else if (!earlier) row.change = "added";
        else if (JSON.stringify(earlier.startFrom) !== JSON.stringify(choice.startFrom) || earlier.delivery !== choice.delivery) { row.change = "changed"; row.previous = earlier; }
      }
      return { row, product, earlier };
    });
    const pendingRows = rows.map(({ row }) => row);
    task.workRows = pendingRows;
    await Promise.all(rows.map(async ({ row, product }) => {
      const { choice } = row;
      try {
        if (!product && !row.addition) {
          const repo = choice.repo ?? choice.productId;
          if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Needs adding: choose a registered product or an exact GitHub repository.");
          const data = await this.effects.repository(repo);
          if (task.workRows !== pendingRows) return;
          const candidate = { id: choice.productId || repo, name: repo.split("/")[1]!, repo, defaultBranch: data.defaultBranch, remote: `https://github.com/${repo}.git` };
          // Resolve branch and PR choices without cloning. A fork stays within this row.
          row.source = { product: candidate, start: { kind: "default", branch: candidate.defaultBranch }, destination: { mode: choice.delivery, kind: choice.delivery === "release" ? "release" : choice.delivery === "local" ? "branch" : "new-pr", repo, branch: candidate.defaultBranch, remote: candidate.remote }, confirmed: false };
          // Validation never creates an addition record: only the coordinator can confirm its folder.
          row.source = await this.effects.resolve(task, choice, candidate);
          row.error = "Needs adding: confirm this product’s name and permanent folder.";
        } else row.source = await this.effects.resolve(task, choice);
      } catch (error) { row.error = error instanceof Error ? error.message : String(error); }
    }));
    // Apply cross-product decisions in the original order, after every independent read has finished.
    // A newer proposal owns its rows and validation flags; a late reply cannot replace them.
    if (task.workRows !== pendingRows) return;
    const seen = new Set<string>();
    for (const { row, product, earlier } of rows) {
      const { choice } = row;
      if (row.source) {
        const repo = row.source.product.repo.toLowerCase();
        if (seen.has(repo)) row.error = "This repository is already included. Leave out the duplicate.";
        seen.add(repo);
      }
      if (!earlier && (product?.approveDelivery !== false) && !task.approveDelivery) {
        task.approveDelivery = true;
        task.approvalExplanation = `${product?.name ?? row.source?.product.name ?? choice.productId} asks before shipping, so shared delivery approval is on. You can change it here.`;
      }
    }
    task.workValidating = false;
    task.workError = !task.workRows.length ? "Choose at least one product." : task.workRows.some((row) => row.error) ? task.workRows.filter((row) => row.error).map((row) => row.error).join("\n") : undefined;
    const item = this.host.planCheck(task.id);
    if (item) item.body = task.workRows.map((row) => [row.source ? workSummary(row.source) : row.choice.productId, row.choice.reason, row.error].filter(Boolean).join("\n")).join("\n\n");
    this.host.commitNow(task);
  }

  confirm(task: RuntimeTask): void {
    const scope = executionFor(task);
    if (task.workValidating) throw new Error("Wait for every product choice to finish validation.");
    if (task.workRows) {
      const invalid = task.workRows.some((row) => {
        if (row.error || !row.source) return true;
        if (this.host.products().some((product) => product.id === row.source!.product.id)) return false;
        const addition = row.addition;
        return !addition?.name.trim() || !this.effects.isAbsoluteFolder(addition.path) || addition.productId !== row.source.product.id || row.source.product.path !== addition.path;
      });
      if (!task.workRows.length || invalid) throw new Error("Correct every product and starting point, and confirm folders for additions before approval.");
      if (new Set(task.workRows.map((row) => row.source!.product.repo.toLowerCase())).size !== task.workRows.length) throw new Error("Choose each repository once.");
      // Validate coverage before replacing any canonical execution records.
      const builder = task.plan?.stages.find((stage) => this.host.role(stage.roleId, task)?.result === "build")?.profileIds[0];
      const reviewers = task.plan?.stages.filter((stage) => stage.kind === "review-chain").flatMap((stage) => stage.profileIds) ?? [];
      if (task.plan && (!builder || !reviewers.length)) throw new Error("Every product needs a builder and review coverage.");

      const prepared = task.repositories;
      task.repositories = task.workRows.map((row) => {
        const prior = prepared?.find((work) => work.productId === row.source!.product.id && JSON.stringify(work.source?.start) === JSON.stringify(row.source!.start) && JSON.stringify(work.source?.destination) === JSON.stringify(row.source!.destination));
        return prior ?? ({ productId: row.source!.product.id, source: { ...row.source!, confirmed: true }, workProduct: row.source!.product, workChoice: row.choice, delivery: row.choice.delivery, completedStages: [], preparation: "waiting" }); });
      task.excludedRepositories = [...(task.excludedRepositories ?? []), ...(prepared ?? []).filter((work) => (work.worktree || work.preparingCopy) && !task.repositories!.some((kept) => kept.productId === work.productId))];
      if (task.plan) {
        task.plan.products = task.workRows.map((row) => ({ productId: row.source!.product.id, builderProfileId: row.choice.builderProfileId && this.host.profileExists(row.choice.builderProfileId) ? row.choice.builderProfileId : builder!, reviewerProfileIds: reviewers }));
        task.plan.leadProductId = task.plan.products.some((work) => work.productId === task.plan!.leadProductId) ? task.plan.leadProductId : task.repositories[0]!.productId;
      }
      task.leadProductId = task.workRows.find((row) => row.choice.lead)?.source?.product.id ?? task.plan?.leadProductId ?? task.repositories[0]!.productId;
      if (task.plan) {
        task.plan.leadProductId = task.leadProductId;
        for (const stage of task.plan.stages) if (stage.kind === "do" && this.host.role(stage.roleId, task)?.result === "delivery") stage.title = task.repositories.length > 1 ? `Deliver across ${task.repositories.length} products` : deliveryLabel({ source: task.repositories[0]!.source, delivery: task.repositories[0]!.delivery });
      }
      task.productId = task.leadProductId;
      const lead = task.repositories.find((work) => work.productId === task.leadProductId)!;
      task.delivery = lead.delivery;
      task.workChoice = lead.workChoice;
      task.activeProductId = task.repositories[0]!.productId;
      detachRepositoryState(task);
      task.confirmWork = false;
      delete task.workError;
      this.host.recordChoice(task, task.workRows.map((row) => workSummary(row.source!)).join("\n\n"));
      return;
    }
    // An older task may already have its working copy and an ordinary plan check.
    if (scope.work.worktree && !scope.work.source && !task.workProposal) return;
    if (task.workError || (!scope.work.source && !task.proposedSource)) throw new Error(task.workError ?? "Choose a valid product and starting point first.");
    if (task.proposedSource) {
      if (scope.work.worktree) throw new Error("This task already has a working copy. Keep its approved starting point, or start a new task for the new destination.");
      scope.work.source = { ...task.proposedSource, confirmed: true };
      scope.work.productId = scope.work.source.product.id;
      scope.work.delivery = scope.work.source.destination.mode;
      task.productId = scope.work.productId;
      task.delivery = scope.work.source.destination.mode;
      task.workChoice = task.workProposal?.[0];
      scope.work.workChoice = task.workChoice;
      scope.work.workProduct = scope.work.source.product;
      delete task.proposedSource;
    }
    task.confirmWork = false;
    this.host.recordChoice(task, workSummary(scope.work.source!));
  }
}
