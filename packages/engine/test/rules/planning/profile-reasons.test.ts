import { expect, it } from "bun:test";
import { PlanResult } from "../../../src/roles.js";
it("rejects mismatched reason counts at the planner schema boundary", () => {
  const result = PlanResult.parse({ rationale: "Use independent roles.", stages: [{ kind: "do", title: "Research", roleId: "researcher", profileIds: ["opus-high"], profileReasons: ["High effort to check the scheduling evidence."] }] });
expect(PlanResult.safeParse({ ...result, stages: [{ ...result.stages[0]!, profileReasons: ["One reason", "An extra reason"] }] }).success).toBe(false);
});
