import { expect, it } from "bun:test";
import { runCommand } from "../../../src/commands.js";
import { expectRejection } from "../../../src/rejections.js";

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
