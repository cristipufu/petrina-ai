import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeAccountReports } from "../../../src/claude-account-report.js";
import { readClaudeUsage } from "../../../src/claude-usage.js";
import { tempDir, waitFor } from "@petrina/test-support/fixtures";
import { testGitEnv } from "@petrina/test-support/test-git-env";
import { readFixtureJsonLines } from "@petrina/test-support/fixture-json";
import { account } from "../../fixtures/claude-account.js";

import { usageActors } from "../../fixtures/usage-actors.js";
const actors = usageActors(); afterAll(() => actors.close());

it("uses only native control requests, then stops the Claude process", async () => {
  const cwd = tempDir("petrina-claude-account-");
  await actors.use(cwd, async f => {
    const log = join(cwd, "requests.jsonl");
    const script = `const {appendFileSync}=require('node:fs');const {createInterface}=require('node:readline');createInterface({input:process.stdin}).on('line',line=>{appendFileSync(${JSON.stringify(log)},line+'\\n');const request=JSON.parse(line);const response={type:'control_response',response:{subtype:'success',request_id:request.request_id,response:request.request.subtype==='get_usage'?${JSON.stringify(account)}:{}}};const text=JSON.stringify(response)+'\\n';process.stdout.write(text.slice(0,20));process.stdout.write(text.slice(20));});`;
    let child: ChildProcess | undefined;
    const command = await f.command([process.execPath, "-e", script]);
    const reports = await f.run(() => readClaudeUsage({ cwd, env: testGitEnv(), command, signal: f.signal, onProcess: value => { f.observe(value); child = value; } }));
    expect(reports).toEqual(claudeAccountReports(account));
    const requests = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(requests.map(request => request.request.subtype)).toEqual(["initialize", "get_usage"]);
    expect(requests.some(request => request.type === "user")).toBe(false);
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    expect(child!.stdout!.closed && child!.stderr!.closed).toBe(true);
    await waitFor(() => child?.exitCode !== null || child?.signalCode !== null, "the usage process to stop");
  });
});

it("fails a refused account request without exposing its response contents", async () => {
  const cwd = tempDir("petrina-claude-account-refused-");
  const script = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);console.log(JSON.stringify({type:'control_response',response:{subtype:'error',request_id:request.request_id,error:'private fixture detail'}}));});`;
  await actors.use(cwd, async f => {
    const command = await f.command([process.execPath, "-e", script]);
    await f.inspect(() => readClaudeUsage({ cwd, env: testGitEnv(), command, signal: f.signal, onProcess: f.observe }), raw => expectRejection(raw, "Claude Code could not read account usage; check its login"));
  });
});

it("cancels a held account report after a lost exit notification and joins actual native cleanup", async () => {
  const cwd = tempDir("petrina-claude-account-held-");
  await actors.use(cwd, async f => {
    const log = join(cwd, "requests.jsonl"), controller = new AbortController();
    const script = `const {appendFileSync}=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{appendFileSync(${JSON.stringify(log)},line+'\\n');const request=JSON.parse(line);if(request.request.subtype==='initialize')console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{}}}));});`;
    const command = await f.command([process.execPath, "-e", script]);
    let child: ChildProcess | undefined, lostExits = 0, closed = false, restore: (() => void) | undefined;
    try {
      await f.inspect(() => readClaudeUsage({ cwd, env: testGitEnv(), command, signal: AbortSignal.any([f.signal, controller.signal]), onProcess(actual) {
        f.observe(actual); child = actual;
        actual.once("close", () => { closed = true; });
        const emit = actual.emit, descriptor = Object.getOwnPropertyDescriptor(actual, "emit");
        restore = () => { if (descriptor) Object.defineProperty(actual, "emit", descriptor); else Reflect.deleteProperty(actual, "emit"); };
        actual.emit = function (this: ChildProcess, event: string | symbol, ...args: unknown[]) {
          if (event === "exit") { lostExits++; return false; }
          return Reflect.apply(emit, this, [event, ...args]);
        };
      } }), async raw => {
        try {
          await waitFor(() => readFixtureJsonLines<{ request: { subtype: string } }>(log)
            .some(record => record.request.subtype === "get_usage"), "the actual held account request", 5_000, { during: raw });
          const cancelled = Date.now(); controller.abort();
          await expectRejection(raw, "The account usage read was stopped");
          // Native stop's 2s + 2s + 2s bound remains separate from the unchanged 30s report timeout.
          expect(Date.now() - cancelled).toBeLessThan(10_000);
          expect(lostExits).toBe(1);
          expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
          expect(closed).toBe(true);
          expect(child!.stdout!.closed && child!.stderr!.closed).toBe(true);
          expect(readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line).request.subtype)).toEqual(["initialize", "get_usage"]);
        } finally { controller.abort(); }
      });
    } finally { controller.abort(); restore?.(); }
  });
});
