import { describe, expect, it } from "bun:test";
import type { AgentProfile } from "@petrina/core";
import { ModelAtCapacity } from "@petrina/agent-runtime/failures";
import { CODEX_MODEL_CAPACITY, codexCapacityFailure, codexModelAtCapacity } from "@petrina/agent-runtime/provider-interruptions";
import { limitFromFailure } from "../../../../agent-runtime/test/fixtures/limit-parsing.js";
import { failureReason } from "../../../src/failure-reason.js";
import { capacityRetryDelay, WaitingForCapacity, WaitingForUsage } from "../../../src/usage.js";
const SENTENCE = CODEX_MODEL_CAPACITY;
describe("telling a full model from an account limit", () => {
  const codex: AgentProfile = { id: "sol-high", toolId: "codex", model: "sol", modelId: "gpt-6.1-sol", effort: "high" };

  it("matches only a turn that ends on the capacity sentence", () => {
    expect(codexModelAtCapacity(`\n${SENTENCE}`)).toBe(true);
    expect(codexModelAtCapacity(`${SENTENCE}\n`)).toBe(true);
    expect(codexModelAtCapacity(`A note along the way said “${SENTENCE}” The work is finished.`)).toBe(false);
  });

  it("leaves usage, rate and session limits on the account, and a full model off it", () => {
    const now = Date.now();
    expect(limitFromFailure(codex, { message: SENTENCE, data: { message: SENTENCE } }, "", now)).toBeUndefined();
    expect(limitFromFailure(codex, { data: { codexErrorInfo: "serverOverloaded" } }, "", now)).toBeUndefined();
    expect(limitFromFailure(codex, { data: { codex_error_info: "server_overloaded" } }, "", now)).toBeUndefined();
    expect(limitFromFailure(codex, { data: { codexErrorInfo: "usageLimitExceeded" } }, "", now)?.reason).toBe("Codex's usage limit");
    expect(limitFromFailure(codex, { data: { codexErrorInfo: "rateLimitExceeded" } }, "", now)?.reason).toBe("Codex's rate limit");
    expect(limitFromFailure(codex, { data: { codexErrorInfo: "sessionBudgetExceeded" } }, "", now)?.reason).toBe("Codex's usage limit");
    expect(limitFromFailure(codex, { data: { codexErrorInfo: "contextWindowExceeded" } }, "", now)).toBeUndefined();
    expect(failureReason(new WaitingForCapacity("The selected model is at capacity"))).toBe("other");
    expect(failureReason(new ModelAtCapacity("codex", "gpt-6.1-sol", "sol-xhigh"))).toBe("other");
    expect(failureReason(new WaitingForUsage("Waiting for usage"))).toBe("limit");
  });

  it("retries the same conversation on a short schedule, and reads Codex's overloaded stop", () => {
    expect(capacityRetryDelay(0)).toBe(5_000);
    expect(capacityRetryDelay(1)).toBe(10_000);
    expect(capacityRetryDelay(2)).toBe(30_000);
    expect(capacityRetryDelay(3)).toBeUndefined();
    expect(capacityRetryDelay(0, 45_000)).toBe(45_000);
    expect(capacityRetryDelay(2, 1_000)).toBe(30_000);
    const failure = { _meta: { jetbrains: { air: { sessionFailure: { severity: "error", category: "service", title: SENTENCE, actions: ["retry"] } } } } };
    const warning = { _meta: { jetbrains: { air: { sessionFailure: { severity: "warning", title: SENTENCE, actions: ["retry"] } } } } };
    expect(codexCapacityFailure({ data: { codexErrorInfo: "serverOverloaded" } })).toEqual({});
    expect(codexCapacityFailure({ data: { codex_error_info: "server_overloaded" } })).toEqual({});
    expect(codexCapacityFailure({ data: { codexErrorInfo: "usageLimitExceeded" } })).toBeUndefined();
    expect(codexCapacityFailure({ data: { codexErrorInfo: "serverOverloaded", retryAfterMs: 45_000 } })).toEqual({ retryAfterMs: 45_000 });
    expect(codexCapacityFailure({ data: { message: SENTENCE, retry_after_seconds: 12 } })).toEqual({ retryAfterMs: 12_000 });
    expect(codexCapacityFailure({ data: { message: SENTENCE, retryAfter: 5_000 } })).toEqual({});
    expect(codexCapacityFailure(failure)).toEqual({});
    expect(codexCapacityFailure(warning)).toBeUndefined();
  });
});
