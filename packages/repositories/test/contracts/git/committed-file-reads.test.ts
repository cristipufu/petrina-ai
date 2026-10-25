import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileAt } from "@petrina/repositories/git";

const folder = tempDir("petrina-instruction-read-");

writeFileSync(join(folder, "package.json"), '{"private":true,"type":"module"}');

afterAll(() => removeDir(folder));

let serial = 0;

async function withGit(script: string, check: () => Promise<void>): Promise<void> {
  const entry = join(folder, `git-${++serial}.ts`);
  writeFileSync(entry, script);
  const spawn = Bun.spawn;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const route = (args: unknown[]) => {
    const command = args[0];
    return Array.isArray(command) && command[0] === "git" && command[1] === "cat-file"
      ? [[process.execPath, entry], ...args.slice(1)] : args;
  };
  const asynchronous = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
    const child = Reflect.apply(spawn, Bun, route(args)) as ReturnType<typeof Bun.spawn>;
    children.push(child);
    return child;
  }) as typeof Bun.spawn);
  try {
    await check();
  } finally {
    asynchronous.mockRestore();
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited));
  }
}

describe("reading a product's committed files",()=>{
it("keeps the event loop responsive while Git reads a guide, and preserves its exact text", async () => {
    await withGit('setTimeout(() => process.stdout.write("\\ufeff\\n# Review guide\\n\\n "), 200)', async () => {
      const order: string[] = [];
      const heartbeat = new Promise<void>((resolve) => setTimeout(() => { order.push("responsive"); resolve(); }, 20));
      const read = Promise.resolve().then(() => fileAt(folder, "HEAD", "REVIEW.md")).then((text) => {
        order.push("read");
        expect(text).toBe("\ufeff\n# Review guide\n\n ");
      });
      await Promise.all([read, heartbeat]);
      expect(order).toEqual(["responsive", "read"]);
    });
  });
});

describe("reading a product's committed files",()=>{
it("reports an expired read as a failure, never as a missing guide", async () => {
    await withGit('setInterval(() => {}, 1000)', async () => {
      await expectRejection(fileAt(folder, "HEAD", "REVIEW.md", 80 * SLOW), "Git did not finish reading");
    });
  });
});

describe("reading a product's committed files",()=>{
it("drains a large saved file and Git's diagnostics while the process is still writing", async () => {
    await withGit('process.stderr.write("d".repeat(256 * 1024)); process.stdout.write("# Guide\\n" + "x".repeat(1024 * 1024) + "\\n")', async () => {
      const text = await fileAt(folder, "HEAD", "REVIEW.md");
      expect(text).toBe("# Guide\n" + "x".repeat(1024 * 1024) + "\n");
    });
  });
});
