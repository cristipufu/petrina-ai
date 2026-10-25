import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { slotAgents as scriptedSlotAgents } from "../../../orchestrator/test/fixtures/slot-agents.js";

/** Same scripted responses, with the actual private repository write retained at its native boundary. */
export function slotAgents() {
  return scriptedSlotAgents(cwd => writeFileSync(join(cwd, "greeting.txt"), "Hello\n"));
}
