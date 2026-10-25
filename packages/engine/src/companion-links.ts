// Finish cross-product PR links after every delivery is recorded. Never republishes a delivery.
import { companionText } from "@petrina/core";
import * as github from "@petrina/repositories/github";
import { api } from "@petrina/repositories/source-github";
import type { Kernel, MTask } from "./kernel.js";

type LinkHost = Pick<Kernel, "commitNow" | "options" | "raise">;
export class CompanionLinks {
  constructor(private readonly k: LinkHost) {}
  async finish(task: MTask): Promise<boolean> {
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
          const comments = (await api(repo, `issues/${number}/comments?per_page=100`, this.k.options.gh)).flat() as { body?: string }[];
          if (!comments.some((comment) => comment.body === text)) {
            const posted = await github.gh(this.k.options.gh ?? ["gh"], repo, ["pr", "comment", String(number), "--body-file", "-"], text);
            if (posted.code) throw new Error(posted.stderr || "Could not confirm the companion comment.");
          }
          const confirmed = (await api(repo, `issues/${number}/comments?per_page=100`, this.k.options.gh)).flat() as { body?: string }[];
          if (!confirmed.some((comment) => comment.body === text)) throw new Error("Could not confirm the companion comment. Check again before retrying.");
        } else {
          const read = await github.gh(this.k.options.gh ?? ["gh"], repo, ["pr", "view", String(number), "--json", "body"]);
          if (read.code) throw new Error("Could not read the companion links. Check again.");
          const body = JSON.parse(read.stdout).body;
          if (typeof body !== "string") throw new Error("GitHub did not return the pull request description.");
          const next = `${body.replace(/\n*Part of a change across: [^\n]*\.?$/u, "")}\n\n${text}`;
          if (body !== next) {
            const edited = await github.gh(this.k.options.gh ?? ["gh"], repo, ["pr", "edit", String(number), "--body-file", "-"], next);
            if (edited.code) throw new Error(edited.stderr || "Could not finish companion links.");
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
