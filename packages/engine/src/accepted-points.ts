// Accepted instructions wait for delivery. Once the default branch contains one, it is no longer
// pending: a later correction or removal in that branch must not be undone by the old queue. A lesson
// leaving the queue keeps a short receipt, so an update can still prove where main's line came from.
import * as git from "@petrina/repositories/git";
import { AGENTS_FILE, GUIDE_FILE, hasPoint } from "@petrina/core";
import type { Kernel } from "./kernel.js";

/** How many receipts a product keeps. */
const RECEIPTS = 100;

export class AcceptedPoints {
  private sweeping = false;

  constructor(private readonly k: Kernel) {}

  async sweep(): Promise<void> {
    if (this.sweeping || this.k.stopped) return;
    this.sweeping = true;
    let changed = false;
    try {
      for (const product of [...this.k.s.products]) {
        const root = product.path;
        const ref = product.defaultBranch;
        if (!root || !ref) continue;
        if (!product.learnings?.length && !product.reviewGuide?.some((line) => !line.incorporatedOn)) continue;
        let sha: string | undefined;
        try { sha = await git.revParse(root, ref); } catch { continue; }
        if (this.k.stopped) return;
        if (!sha) continue;
        for (const [field, name] of [["learnings", AGENTS_FILE], ["reviewGuide", GUIDE_FILE]] as const) {
          if (!product[field]?.length) continue;
          if (field === "reviewGuide" && !product.reviewGuide?.some((line) => !line.incorporatedOn)) continue;
          let file: string | undefined;
          try { file = await git.fileAt(root, sha, name); }
          catch { continue; } // An unavailable repository proves nothing; keep its pending instructions.
          if (this.k.stopped) return;
          if (file === undefined || !this.k.s.products.includes(product) || product.path !== root || product.defaultBranch !== ref) continue;
          // Read the live queue after Git answers: a coordinator may have accepted another point meanwhile.
          const current = product[field] ?? [];
          if (field === "reviewGuide") {
            // A task pinned before this commit still needs the accepted rule in its review context.
            // Keep that history, but never write the incorporated rule into a later delivery again.
            for (const line of current) if (!line.incorporatedOn && hasPoint(file, line.text)) {
              line.incorporatedOn = sha;
              changed = true;
            }
          } else {
            const found = current.filter((line) => hasPoint(file, line.text));
            if (found.length) {
              product.learnings = current.filter((line) => !found.includes(line));
              const receipts = found.map((line) => ({ text: line.text, fromTask: line.fromTask, ...(line.writtenOn ? { writtenOn: line.writtenOn } : {}), foundOn: sha }));
              product.learningReceipts = [...(product.learningReceipts ?? []), ...receipts].slice(-RECEIPTS);
              changed = true;
            }
          }
        }
      }
    } finally {
      this.sweeping = false;
      if (changed && !this.k.stopped) this.k.commit();
    }
  }
}
