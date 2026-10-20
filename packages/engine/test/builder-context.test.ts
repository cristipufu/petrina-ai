import { expect, it } from "bun:test";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILT_IN_ROLES, createDemoState } from "@petrina/core";
import { builderContext } from "../src/builder-context.js";
import { Cleanup } from "../src/cleanup.js";
import { makeWorld, removeDir, tempDir } from "./support.js";

it("omits unchanged handoffs, guide points, follow-ups and PR descriptions while retaining changed context", async () => {
  const root = tempDir("petrina-background-delta-");
  try {
    const task = createDemoState(1_000_000_000).tasks[0]!;
    const sections = ["What earlier agents on this task handed back", "Points the coordinator accepted for the review guide, not in REVIEW.md yet", "Open follow-up cards", "The pull request description you wrote last time"].map((title) => ({ title, body: `Original ${title}` }));
    for (const id of ["builder", "code-reviewer"]) {
      const role = BUILT_IN_ROLES.find((entry) => entry.id === id)!;
      const first = await builderContext(root, task, role, id, sections);
      const next = await builderContext(root, task, role, id, sections, first.snapshot);
      expect(next.sections.map((section) => section.title)).toEqual(["Current authoritative task context"]);
      const packet = await readFile(next.snapshot!.file, "utf8");
      for (const section of sections) expect(packet).toContain(section.body);
      const changed = sections.map((section, index) => index === 1 ? { ...section, body: "A newly accepted requirement" } : section);
      const updated = await builderContext(root, task, role, id, changed, next.snapshot);
      expect(updated.sections.slice(1)).toEqual([changed[1]!]);
      const removed = await builderContext(root, task, role, id, changed.slice(1), updated.snapshot);
      expect(removed.sections[0]!.body).toContain(`Earlier sections no longer apply: ${sections[0]!.title}#1`);
    }
  } finally { removeDir(root); }
});

it("sends changed Builder context and every new finding while keeping full authoritative context readable", async () => {
  const root = tempDir("petrina-builder-context-");
  try {
    const task = createDemoState(1_000_000_000).tasks[0]!;
    const role = BUILT_IN_ROLES.find((entry) => entry.id === "builder")!;
    const sections = [{ title: "Design brief", body: "A design constraint. ".repeat(600) }, { title: "The coordinator's notes on this task", body: "Keep the complete feature." }, { title: "Review findings (answer every one by id)", body: "Fix finding one with its original diagnostic." }];
    const first = await builderContext(root, task, role, "own-session", sections);
    expect(first.sections).toEqual(sections);
    const changed = [...sections.slice(0, 2), { ...sections[2]!, body: "Fix finding two with fresh proof and the saved complete log." }];
    const next = await builderContext(root, task, role, "own-session", changed, first.snapshot);
    expect(next.sections.map((section) => section.title)).toEqual(["Current authoritative task context", changed[2]!.title]);
    expect(next.sections[1]!.body).toBe(changed[2]!.body);
    expect(next.sections[0]!.body).toContain("compacted");
    expect(next.sections.map((section) => section.body).join("").length).toBeLessThan(sections[0]!.body.length / 2);
    expect(await readFile(next.snapshot!.file, "utf8")).toContain(sections[0]!.body);
    expect(await readFile(next.snapshot!.file, "utf8")).toContain(changed[2]!.body);
    expect((await stat(next.snapshot!.file)).mode & 0o777).toBe(0o600);

    const newBrief = [{ ...changed[0]!, body: "A changed authoritative requirement." }, ...changed.slice(1)];
    const revised = await builderContext(root, task, role, "own-session", newBrief, next.snapshot);
    expect(revised.sections.some((section) => section.body === newBrief[0]!.body)).toBe(true);
    const newRole = await builderContext(root, task, { ...role, instructions: "Use the new role rules." }, "own-session", changed, next.snapshot);
    expect(newRole.sections).toEqual(changed);
    expect((await builderContext(root, task, role, "fresh-session", changed, next.snapshot)).sections).toEqual(changed);
    expect((await builderContext(root, { ...task, baseSha: "another-source" }, role, "own-session", changed, next.snapshot)).sections).toEqual(changed);
    await rm(next.snapshot!.file);
    expect((await builderContext(root, task, role, "own-session", newBrief, next.snapshot)).sections).toEqual(newBrief);
    await writeFile(first.snapshot!.file, "Damaged context");
    expect((await builderContext(root, task, role, "own-session", changed, first.snapshot)).sections).toEqual(changed);
  } finally { removeDir(root); }
});

it("removes terminal and orphaned context packets while retaining an unfinished task's fallback", async () => {
  const world = makeWorld("builder-context-cleanup");
  const engine = world.start();
  try {
    engine.setPoolPaused(true);
    const productId = await engine.addProduct(world.clone);
    const active = engine.addTask({ productId, title: "An unfinished builder", backlog: true });
    const finished = engine.addTask({ productId, title: "A finished builder", backlog: true });
    engine.task(finished)!.state = "done";
    engine.commitNow();
    for (const id of [active, finished, "orphaned-context"]) {
      await mkdir(join(world.data, "contexts", id), { recursive: true });
      await writeFile(join(world.data, "contexts", id, "context.md"), "Authoritative context");
    }
    await new Cleanup(engine).sweep();
    expect(await readFile(join(world.data, "contexts", active, "context.md"), "utf8")).toBe("Authoritative context");
    await expect(access(join(world.data, "contexts", finished))).rejects.toThrow();
    await expect(access(join(world.data, "contexts", "orphaned-context"))).rejects.toThrow();
  } finally { await engine.shutdown(); removeDir(world.dir); }
});
