import { expect, it } from "bun:test";
import { runCommand } from "../../../src/commands.js";
import { expectRejection } from "../../../src/rejections.js";
import { resourceUsageRecord } from "../../../src/resources/usage.js";

it("streams every output byte without retaining a duplicate command result", async () => {
  let bytes = 0, errors = "";
  const result = await runCommand([process.execPath, "-e", "process.stdout.write('x'.repeat(200000));process.stderr.write('complete');"], {
    retainOutput: false, onOutput: (text, stream) => { if (stream === "stdout") bytes += text.length; else errors += text; return undefined; },
  });
  expect(bytes).toBe(200000); expect(errors).toBe("complete");
  expect(result).toEqual({ code: 0, stdout: "", stderr: "", outputRetained: false });
});

it("refuses to discard output without an observer before launching anything", async () => {
  let starts = 0;
  await expectRejection(runCommand(["unused"], { retainOutput: false, start: () => { starts++; throw new Error("must not start"); } }), "output observer");
  expect(starts).toBe(0);
});

it("serializes actual available child-driver counters after owned command completion", async () => {
  let reading: ReturnType<ReturnType<typeof Bun.spawn>["resourceUsage"]>;
  const result = await runCommand([process.execPath, "-e", "process.stdout.write('complete');"], {
    start: (argv, { output: _output, ...options }) => {
      const child = Bun.spawn(argv, { ...options, stdout: "pipe", stderr: "pipe", windowsHide: true });
      return { pid: child.pid, stdout: child.stdout, stderr: child.stderr,
        exited: child.exited.then(code => { reading = child.resourceUsage(); return code; }),
        get exitCode() { return child.exitCode; }, get signalCode() { return child.signalCode as string | null; }, kill: signal => child.kill(signal) };
    },
  });
  expect(result.code).toBe(0); expect(result.stdout).toBe("complete");
  const record = resourceUsageRecord(reading);
  if (!reading) expect(record).toBeUndefined();
  else expect(JSON.parse(JSON.stringify(record))).toEqual({ userUs: Number(reading.cpuTime.user), systemUs: Number(reading.cpuTime.system), totalUs: Number(reading.cpuTime.total), maxRssBytes: Number(reading.maxRSS) });
});
