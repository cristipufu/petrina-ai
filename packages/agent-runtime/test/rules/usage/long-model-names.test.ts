import { describe, expect, it } from "bun:test";
import { genericTurnReport } from "../../../src/turn-report.js";
describe("An agent session", () => {
it("keeps unfamiliar model names exactly as reported, including long names with different endings", () => {
    const prefix = `unfamiliar-${"model-".repeat(40)}`;
    const names = [`${prefix}[fast]`, `${prefix}[careful]`];
    const report = genericTurnReport({ _meta: { quota: { model_usage: names.map((model) => ({ model, token_count: { inputTokens: 10, outputTokens: 5 } })) } } });
    expect(report?.models?.map((row) => row.model)).toEqual(names);
});
});
