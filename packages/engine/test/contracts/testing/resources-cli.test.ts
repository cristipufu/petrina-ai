import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { afterAll, afterEach, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir, removeDir, waitFor } from "@petrina/test-support/fixtures";
import { runCommand } from "@petrina/test-support/commands";
import { childState } from "@petrina/platform/process-tree";
import { coordinatorLifetimes } from "../../fixtures/coordinator-lifetime.js";
import { closeControlledRunner, entryFixture, isolatedRunnerEnvironment } from "../../fixtures/required-suite.js";

const cli = fileURLToPath(import.meta.resolve("../../quality/resources.ts"));
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const settlementCases = coordinatorLifetimes();
afterEach(() => settlementCases.close());
afterAll(() => settlementCases.close());
it("prints profiler help without beginning a full suite", async () => {
  const result = await runCommand([process.execPath, cli, "--help"]);
  expect(result.code).toBe(0); expect(result.stdout).toContain("--report DIR");
  expect(result.stdout).not.toContain("Affected-test observation:");
});
it("rejects an empty event file instead of manufacturing a zero-cost report", async () => {
  const cwd = tempDir("petrina-resource-report-"); roots.push(cwd);
  const events = join(cwd, "events"); mkdirSync(events); writeFileSync(join(events, "events-empty.jsonl"), "");
  const result = await runCommand([process.execPath, cli, "--report", events]);
  expect(result.code).toBe(1); expect(result.stderr).toContain("No valid resource case evidence");
  expect(result.stdout).not.toContain("Observed launch calls:");
});

for (const completedFirst of [false, true]) it(completedFirst ? "records a diagnostic failure when a final sampler is uncertain after the actual full command completed successfully" : "retains the diagnostic environment and stops its actual full command after uncertain sampler settlement", async () => {
  const root = tempDir("petrina-resource-settlement-"), lifetime = await settlementCases.open(root);
  let browsers: string | undefined;
  const close = () => closeControlledRunner(lifetime, browsers);
  await setupWithCleanup(() => lifetime.prepare(async () => {
      entryFixture(root);
      const quality = join(root, "packages/engine/test/quality"), target = join(quality, "resources.ts");
      const record = join(root, "sampler-observation.json"), captured = join(root, "full-command.json"), release = join(root, "release-full");
      const marker = 'import { runCommand, CommandFailure, type Start, type Started } from "@petrina/test-support/commands";';
      const original = readFileSync(target, "utf8");
      if (original.split(marker).length !== 2) throw new Error("The resource fixture needs one canonical command import");
      // Only the sampler's unavailable observation is controlled. The full command uses its real native starter.
      const instrumented = `let samplerCalls = 0, fullCode: number | undefined;
let fullFulfilled!: () => void, fullRejected!: (error: unknown) => void;
const fullObserved = new Promise<void>((resolve, reject) => { fullFulfilled = resolve; fullRejected = reject; });
void fullObserved.catch(() => undefined);
const runCommand: typeof actualRunCommand = (argv, options = {}) => {
  if (!options.onOutput) {
    samplerCalls++;
    if (${JSON.stringify(completedFirst)} && samplerCalls === 1) {
      // Release the actual full command and join its canonical result before allowing the next sample.
      require("node:fs").writeFileSync(${JSON.stringify(release)}, "");
      return actualRunCommand(argv, options).then(async sample => { await fullObserved; return sample; });
    }
    writeFixtureJson(${JSON.stringify(record)}, { calls: samplerCalls, fullCode, folder: options.env?.TMPDIR, home: options.env?.HOME, browsers: options.env?.PETRINA_TEST_BROWSERS, argv });
    return Promise.reject(new CommandFailure("controlled sampler cleanup uncertainty", "unreadable", "", "", "unconfirmed"));
  }
  const full = actualRunCommand(argv, { ...options, start(args, settings) {
    if (!options.start) throw new Error("The fixture requires the resource driver's actual native starter");
    const child = options.start(args, settings);
    writeFixtureJson(${JSON.stringify(captured)}, { pid: child.pid });
    return child;
  } });
  void full.then(result => { fullCode = result.code; fullFulfilled(); }, fullRejected);
  return full;
};\n` + original.replace(marker, 'import { runCommand as actualRunCommand, CommandFailure, type Start, type Started } from "@petrina/test-support/commands";');
      writeFileSync(target, instrumented);
      const actor = lifetime.program("measured-full.ts", `const { existsSync } = require("node:fs"); while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(20); process.exit(0);`);
      writeFileSync(join(quality, "full-run.ts"), readFileSync(actor, "utf8"));
      const child = lifetime.start(root, [target], isolatedRunnerEnvironment(root));
      await waitFor(() => existsSync(record), "the actual resource driver to observe its controlled sampler failure", undefined, { during: child.completion });
      // A real independent release also lets the original unsafe runner finish, so its deletion is observable.
      writeFileSync(release, "");
      const result = await child.completion;
      const observed = JSON.parse(readFileSync(record, "utf8"));
      browsers = observed.browsers;
      expect(result.code, result.stdout + result.stderr).toBe(1);
      expect(observed.calls).toBe(completedFirst ? 2 : 1);
      if (completedFirst) expect(observed.fullCode).toBe(0);
      expect(relative(root, observed.folder)).not.toStartWith("..");
      expect(observed.folder).not.toBe(root);
      expect(existsSync(observed.folder)).toBe(true);
      expect(existsSync(observed.home)).toBe(true);
      expect(existsSync(observed.browsers)).toBe(true);
      const folder = result.stdout.match(/Resource artifacts: ([^\r\n]+)/)?.[1];
      expect(folder).toBeDefined();
      const report = JSON.parse(readFileSync(join(folder!, "run.json"), "utf8"));
      expect(report.privateEnvironment).toBe("retained");
      expect(report.code).toBe(1);
      if (completedFirst) expect(report.fullExitCode).toBe(0);
      expect(report.sampling.errors).toContain("Process sampler settlement was not confirmed: controlled sampler cleanup uncertainty");
      // The controlled legacy error supplied no execution observations.
      expect(report.sampling.commandFailures).toBeUndefined();
      expect(result.stderr).toContain("Test command settlement was not confirmed; private files retained");
      const actual = JSON.parse(readFileSync(captured, "utf8"));
      expect(actual.pid).toBeGreaterThan(0);
      if (report.fullFailureExecution) {
        expect(report.fullFailureExecution.pid).toBe(actual.pid);
        expect(report.fullFailureExecution.atFailure.exitPromiseReported).toBe(report.fullFailureExecution.atFailure.exitPromiseCode !== undefined);
      } else expect(report.fullExitCode).toBe(0);
      // Subject termination is observed before the independent lease/handle fallback in finally.
      expect(await childState(actual.pid)).toBe("ended");
    }), close);
  await close();
  if (browsers) expect(existsSync(browsers)).toBe(false);
});
