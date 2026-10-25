import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeAccountReports } from "../../../src/claude-account-report.js";
import { readClaudeUsage } from "../../../src/claude-usage.js";
import { removeDir, tempDir, waitFor } from "@petrina/test-support/fixtures";
import { testGitEnv } from "@petrina/test-support/test-git-env";
import { account } from "../../fixtures/claude-account.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

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
