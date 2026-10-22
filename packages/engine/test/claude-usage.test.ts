import { expectRejection } from "./rejections.js";
import { afterAll, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeAccountReports, readClaudeUsage } from "../src/claude-usage.js";
import { removeDir, tempDir, testGitEnv, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const account = { rate_limits_available: true, rate_limits: {
  five_hour: { utilization: 0, resets_at: null },
  seven_day: { utilization: 35, resets_at: "2026-10-28T12:00:00Z" },
  model_scoped: [{ display_name: "Fable", utilization: 100, resets_at: "2026-10-28T12:00:00Z" }],
  extra_usage: { is_enabled: false, utilization: 100 },
} };

it("reads real zeroes and named model quotas without blocking included work on disabled extra usage", () => {
  const reports = claudeAccountReports(account);
  expect(reports).toHaveLength(3);
  expect(reports[0]).toEqual({ toolId: "claude-code", kind: "five_hour", status: "allowed", utilization: 0, claudeAccountComplete: true });
  expect(reports[1]?.resetsAt).toBe(Date.parse("2026-10-28T12:00:00Z"));
  expect(reports[2]).toMatchObject({ kind: "seven_day_overage_included", model: "fable", status: "rejected", utilization: 1 });
  expect(reports.some(report => report.kind === "overage")).toBe(false);
});

it("does not invent readings from unavailable, missing, or invalid account data", () => {
  expect(claudeAccountReports({ ...account, rate_limits_available: false })).toEqual([]);
  expect(claudeAccountReports({ rate_limits_available: true, rate_limits: { five_hour: { utilization: null }, seven_day: { utilization: 101 } } })).toEqual([]);
  expect(claudeAccountReports(null)).toEqual([]);
});

it("retains family scope and paid allowance only when Claude reports it available", () => {
  const reports = claudeAccountReports({ rate_limits_available: true, rate_limits: {
    seven_day: { utilization: 100 }, seven_day_opus: { utilization: 95 },
    extra_usage: { is_enabled: true, utilization: 25 },
  } });
  expect(reports[0]).toMatchObject({ status: "rejected", overage: true });
  expect(reports[1]).toMatchObject({ model: "opus", status: "allowed_warning" });
});

it("combines legacy family rows with named rows and gives a model only one current identity", () => {
  const reports = claudeAccountReports({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 5 }, seven_day: { utilization: 2 },
    seven_day_opus: { utilization: 100 }, seven_day_sonnet: { utilization: 60 },
    model_scoped: [{ display_name: "Opus", utilization: 10 }, { display_name: "Fable", utilization: 30 }],
  } });
  expect(reports.find(report => report.model === "opus")).toMatchObject({ kind: "seven_day_opus", utilization: 0.1, status: "allowed" });
  expect(reports.filter(report => report.model === "opus")).toHaveLength(1);
  expect(reports.find(report => report.model === "sonnet")?.utilization).toBe(0.6);
  expect(reports.find(report => report.model === "fable")?.kind).toBe("seven_day_overage_included");
  expect(reports[0]?.claudeAccountComplete).toBe(true);
  const partial = claudeAccountReports({ ...account, rate_limits: { ...account.rate_limits, seven_day_opus: { utilization: null } } });
  expect(partial[0]?.claudeAccountComplete).toBeUndefined();
});

it("uses only native control requests, then stops the Claude process", async () => {
  const cwd = tempDir("petrina-claude-account-"); roots.push(cwd);
  const log = join(cwd, "requests.jsonl");
  const script = `const {appendFileSync}=require('node:fs');const {createInterface}=require('node:readline');createInterface({input:process.stdin}).on('line',line=>{appendFileSync(${JSON.stringify(log)},line+'\\n');const request=JSON.parse(line);const response={type:'control_response',response:{subtype:'success',request_id:request.request_id,response:request.request.subtype==='get_usage'?${JSON.stringify(account)}:{}}};const text=JSON.stringify(response)+'\\n';process.stdout.write(text.slice(0,20));process.stdout.write(text.slice(20));});`;
  let child: ChildProcess | undefined;
  const reports = await readClaudeUsage({ cwd, env: testGitEnv(), command: [process.execPath, "-e", script], onProcess: value => { child = value; } });
  expect(reports).toEqual(claudeAccountReports(account));
  const requests = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(requests.map(request => request.request.subtype)).toEqual(["initialize", "get_usage"]);
  expect(requests.some(request => request.type === "user")).toBe(false);
  await waitFor(() => child?.exitCode !== null || child?.signalCode !== null, "the usage process to stop");
});

it("fails a refused account request without exposing its response contents", async () => {
  const cwd = tempDir("petrina-claude-account-refused-"); roots.push(cwd);
  const script = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);console.log(JSON.stringify({type:'control_response',response:{subtype:'error',request_id:request.request_id,error:'private fixture detail'}}));});`;
  await expectRejection(readClaudeUsage({ cwd, env: testGitEnv(), command: [process.execPath, "-e", script] }), "Claude Code could not read account usage; check its login");
});
