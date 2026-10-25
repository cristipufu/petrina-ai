import { afterAll, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir, removeDir } from "../../../src/fixtures.js";
import { runCommand } from "../../../src/commands.js";
import { ResourceSummary } from "../../../src/resources/summary.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
it("observes a real isolated native worker without changing decorators, callbacks, skips or command output", async () => {
  const cwd = tempDir("petrina-resource-observer-"), output = join(cwd, "events"); roots.push(cwd); mkdirSync(output);
  const file = join(cwd, "observer.test.ts"), report = join(cwd, "result.xml");
  writeFileSync(file, `import {test,describe,expect} from 'bun:test'; import childProcess,{spawn} from 'node:child_process';
test('top level',()=>expect(2).toBe(2));
describe('fixture suite',()=>{
  test('promise',async()=>{const child=Bun.spawn([process.execPath,'-e','process.stdout.write("fixture")'],{stdout:'pipe'});expect(await new Response(child.stdout).text()).toBe('fixture');expect(await child.exited).toBe(0);});
  test.each([1,2])('each %s',value=>expect(value).toBeGreaterThan(0));
  test('callback',(done)=>{const child=spawn(process.execPath,['-e','process.exit(0)']);child.once('exit',code=>{expect(code).toBe(0);done();});});
  test('missing sync executable',()=>{const result=childProcess.spawnSync('petrina-resource-observer-missing-executable',[]);expect(result.error?.code).toBe('ENOENT');});
  test.skip('skipped',()=>{throw new Error('must remain skipped');});
});`);
  const preload = fileURLToPath(import.meta.resolve("../../../src/resources/preload.ts"));
  const outcome = await runCommand([process.execPath, "--no-env-file", "test", "--parallel", "--preload", preload, "--reporter=junit", `--reporter-outfile=${report}`, file], {
    cwd, env: { ...process.env, PETRINA_TEST_RESOURCE_DIR: output },
  });
  expect(outcome.code, outcome.stderr).toBe(0);
  const junit = readFileSync(report, "utf8");
  expect(junit).toContain('tests="7"'); expect(junit).toContain('skipped="1"'); expect(junit).toContain('failures="0"');
  const summary = new ResourceSummary();
  const events: Record<string, unknown>[] = [];
  for (const path of readdirSync(output)) for (const line of readFileSync(join(output, path), "utf8").trim().split("\n")) if (line) events.push(JSON.parse(line));
  for (const event of events) summary.accept(event);
  expect(summary.report()).toMatchObject({ observedCases: 6, observedLaunchCalls: 2, callsWithReportedChildPid: 2, failedLaunchCalls: 1, unattributedLaunches: 0, unfinishedCases: 0, truncated: false });
  expect(summary.report().programs.bun).toBe(2);
  expect(events.filter(event => event.kind === "case-end").map(event => (event.case as { name: string }).name)).toEqual([
    "top level", "fixture suite > promise", "fixture suite > each 1", "fixture suite > each 2", "fixture suite > callback", "fixture suite > missing sync executable",
  ]);
  expect(summary.report().topByDuration.every(cost => cost.file.endsWith("observer.test.ts"))).toBe(true);
  expect(summary.report().completedFiles).toEqual([file]);
});
