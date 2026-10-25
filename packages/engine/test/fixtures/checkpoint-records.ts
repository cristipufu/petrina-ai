import type { Engine } from "../engine.js";

/** Only recorded product identity is relevant to these checkpoint/notes contracts; no repository is inspected. */
export function recordedCheckpointProduct(engine: Engine, id = "product", name = "Product"): string {
  engine.s.products.push({ id, name, repo: `local/${id}`, tone: "blue", delivery: "pull-request" });
  return id;
}
