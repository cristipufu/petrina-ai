// Accepted instructions wait for delivery. Once the default branch contains one, it is no longer
// pending: a later correction or removal in that branch must not be undone by the old queue.
import * as git from "./git.js";
import { AGENTS_FILE, GUIDE_FILE, hasPoint } from "./points.js";
import type { Kernel } from "./kernel.js";

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
        for (const [field, name] of [["learnings", AGENTS_FILE], ["reviewGuide", GUIDE_FILE]] as const) {
          if (!product[field]?.length) continue;
          let file: string | undefined;
          try { file = await git.fileAt(root, ref, name); }
          catch { continue; } // An unavailable repository proves nothing; keep its pending instructions.
          if (this.k.stopped) return;
          if (file === undefined || !this.k.s.products.includes(product) || product.path !== root || product.defaultBranch !== ref) continue;
          // Read the live queue after Git answers: a coordinator may have accepted another point meanwhile.
          const current = product[field] ?? [];
          const pending = current.filter((line) => !hasPoint(file, line.text));
          if (pending.length !== current.length) {
            product[field] = pending;
            changed = true;
          }
        }
      }
    } finally {
      this.sweeping = false;
      if (changed && !this.k.stopped) this.k.commit();
    }
  }
}
