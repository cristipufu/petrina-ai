// Finish cross-product PR links after every delivery is recorded. Never republishes a delivery.
import { companionText } from "@petrina/core";
import type { Kernel, RuntimeTask } from "./kernel.js";

type LinkHost = Pick<Kernel, "commitNow" | "github" | "raise">;
export class CompanionLinks {
  constructor(private readonly k: LinkHost) {}
  async finish(task: RuntimeTask): Promise<boolean> {
    // Linking has its own saved progress and recovery; it never reopens or republishes a delivery.
    const text = companionText(task.repositories!);
    if (text) for (const work of task.repositories!.filter((entry) => entry.pr)) {

      task.activeProductId = work.productId;
      if (work.companion?.state === "done" && work.companion.text === text) continue;
      work.companion = { text, state: "checking" };
      task.statusLine = `Finishing companion links for ${work.source!.product.name}`;
      this.k.commitNow();
      try {
        const repo = work.source!.product.repo;
        const number = work.pr!.number;
        const existing = work.source!.destination.kind === "update-pr";
        if (existing) {
          const comments = await this.k.github.comments(repo, number);
          if (!comments.some((comment) => comment.body === text)) {
            await this.k.github.comment(repo, number, text);
          }
          const confirmed = await this.k.github.comments(repo, number);
          if (!confirmed.some((comment) => comment.body === text)) throw new Error("Could not confirm the companion comment. Check again before retrying.");
        } else {
          const body = await this.k.github.description(repo, number);
          const next = `${body.replace(/\n*Part of a change across: [^\n]*\.?$/u, "")}\n\n${text}`;
          if (body !== next) {
            await this.k.github.editDescription(repo, number, next);
          }
        }
        work.companion.state = "done";
        this.k.commitNow();
      } catch (error) {
        work.companion.state = "pending";
        this.k.raise(task, "stuck", "Deliveries are saved; companion links need finishing", false, { body: String(error) });
        task.statusLine = "Deliveries saved. Finish links";
        this.k.commitNow();
        return false;
      }
    }
    return true;
  }
}
