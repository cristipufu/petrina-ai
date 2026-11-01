import { afterAll, expect, it } from "bun:test";
import { PROVIDER_IDS, type ToolCheck } from "@petrina/core";
import { contextStageFixtures } from "../../fixtures/context-stage.js";

const prepared = contextStageFixtures();
afterAll(() => prepared.close());

const observed: Pick<ToolCheck, "id" | "status" | "account" | "detail">[] = [
  ...PROVIDER_IDS.map((id) => ({ id, status: "ready" as const })),
  { id: "gh", status: "unknown", detail: "This test must supply a scripted GitHub command." },
  { id: "git", status: "ready" },
];

for (const stage of ["reviewer", "design"] as const) {
  for (const nativeProbes of [true, false]) {
    it(`preserves calibrated ${stage} availability with ${nativeProbes ? "native" : "scripted"} probes`, async () => {
      const f =
        stage === "reviewer"
          ? await prepared.reviewRun("resume", { single: true, nativeProbes })
          : await prepared.designRun("resume", undefined, undefined, { nativeProbes });
      return f.use(async () => {
        try {
          const checks = f.engine().s.setup!.checks.map(({ id, status, account, detail }) => ({
            id,
            status,
            ...(account ? { account } : {}),
            ...(detail ? { detail } : {}),
          }));
          expect(checks).toEqual(observed);
        } finally {
          await f.shutdown();
        }
      });
    });
  }
}
