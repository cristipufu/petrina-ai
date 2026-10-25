import { describe as originalDescribe } from "vitest";
import { expect, it } from "vitest";
import { confirmContainerRemoval } from "../../../src/validation-removal.js";

originalDescribe("required extra validation shares the host check queue", () => {
for (const mode of ["slow removal", "short remaining window", "unresponsive"] as const) it(`confirms removal with an unchanged service-read allowance: ${mode}`, async () => {

    let now = 100, reads = 0;
    const start = now, budgets: number[] = [];
    const clock = { now: () => now, sleep: async (ms: number) => { now += ms; } };
    const inspect = async (timeout = 4_000) => {
      budgets.push(timeout); reads++;
      const latency = mode === "unresponsive" ? 4_001 : mode === "short remaining window" && reads === 1 ? 3_900 : 100;
      await clock.sleep(Math.min(latency, timeout));
      if (latency > timeout) throw new Error("Controlled container inspection timed out");
      return mode === "slow removal" && now - start < 1_500 || mode === "short remaining window" && reads === 1 ? ["owned-container"] : [];
    };
    {
      expect(await confirmContainerRemoval(inspect, 4_000, clock)).toBe(mode !== "unresponsive");
      expect(budgets.every(budget => budget === 4_000)).toBe(true);
      expect(now - start).toBeLessThan(8_000);
      if (mode === "unresponsive") { expect(reads).toBe(1); expect(now - start).toBe(4_000); }
      else expect(now - start).toBeGreaterThan(1_000);
    }
  });
});
