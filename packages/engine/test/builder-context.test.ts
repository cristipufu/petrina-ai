import { expect, it } from "bun:test";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILT_IN_ROLES, createDemoState } from "@petrina/core";
import { builderContext } from "../src/builder-context.js";
import { formatFindings } from "../src/prompts.js";
import { Cleanup } from "../src/cleanup.js";
import { makeWorld, removeDir, tempDir } from "./support.js";

it("keeps complete repair evidence for fresh Builders and sends only changed repair records on continuation", async () => {
  const root = tempDir("builder-repair-evidence-");
  try {
    const role = BUILT_IN_ROLES.find(entry => entry.result === "build")!;
    const finding = { id: "repair", text: "The failure", evidence: "Diagnostic ".repeat(300), steps: "Reproduce the reported case", status: "open" as const, severity: "blocking" as const, raisedBy: "sol-high", confirmedBy: ["opus-high"], votes: [{ by: "grok-high", toolId: "grok", verdict: "real" as const, reason: "Specific independent proof" }] };
    const task = { ...createDemoState(1_000_000_000).tasks[0]!, findings: [finding], fixing: true };
    const sections = () => [{ title: "Review findings (answer every one by id; fix every Important one)", body: formatFindings(task.findings, { complete: true }) }];
    const first = await builderContext(root, task, role, "builder", sections());
    expect(first.sections[0]!.body).toContain(finding.evidence);
    expect(first.sections[0]!.body).toContain("Specific independent proof");
    const continued = await builderContext(root, task, role, "builder", sections(), first.snapshot);
    expect(continued.sections.map(section => section.body).join("\n")).not.toContain(finding.evidence);
    expect(continued.sections[1]!.body).toContain("Answer every open finding by id");
    task.findings[0] = { ...finding, evidence: "New current reproduction" };
    const changed = await builderContext(root, task, role, "builder", sections(), continued.snapshot);
    expect(changed.sections.at(-1)!.body).toContain("New current reproduction");
    expect(changed.sections.at(-1)!.body).toContain("Specific independent proof");
    expect((await builderContext(root, task, role, "replacement", sections(), changed.snapshot)).sections).toEqual(sections());
  } finally { removeDir(root); }
});

it("reduces unchanged finding records only within an intact native conversation and carries every changed field", async () => {
  const root = tempDir("review-finding-deltas-");
  try {
    const task = createDemoState(1_000_000_000).tasks[0]!;
    const role = BUILT_IN_ROLES.find((entry) => entry.id === "code-reviewer")!;
    const unchanged = { id: "old", text: "A long old report ".repeat(300), status: "fixed" as const, severity: "blocking" as const, raisedBy: "sol-high", confirmedBy: [] };
    const changed = { ...unchanged, id: "changed", text: "A later finding", productIds: ["api"], evidence: "Original proof" };
    const sections = (findings: readonly import("@petrina/core").Finding[]) => [{ title: "Findings so far (confirm or dispute by id)", body: formatFindings(findings) }];
    const first = await builderContext(root, task, role, "native-session", sections([unchanged, changed]), undefined, { findings: [unchanged, changed] });
    const updated = { ...changed, productIds: ["web"], evidence: "Changed proof", answer: { fixed: true, text: "Builder response", at: 2 }, votes: [{ by: "opus-high", toolId: "claude-code", verdict: "real" as const, reason: "Fresh proof" }], disputes: [{ by: "sol-high", reason: "Counterexample", at: 2 }] };
    const current = [unchanged, updated];
    const next = await builderContext(root, task, role, "native-session", sections(current), first.snapshot, { findings: current });
    expect(next.sections[0]!.title).toBe("Current authoritative task context");
    expect(next.sections.find((section) => section.title === "Current finding status index")!.body).toContain("old: fixed");
    const delta = next.sections.find((section) => section.title.startsWith("New or changed finding"))!;
    expect(delta.body).toContain("Products: web");
    expect(delta.body).toContain("Changed proof");
    expect(delta.body).toContain("Builder response");
    expect(delta.body).toContain("Fresh proof");
    expect(delta.body).toContain("Counterexample");
    expect(next.sections.map((section) => section.body).join("\n")).not.toContain(unchanged.text);
    expect(await readFile(next.snapshot!.file, "utf8")).toContain(unchanged.text);
    expect(await readFile(next.snapshot!.file, "utf8")).toContain("Counterexample");
    const continued = await builderContext(root, task, role, "native-session", sections(current), JSON.parse(JSON.stringify(next.snapshot)), { findings: current });
    expect(continued.sections.some((section) => section.title.startsWith("New or changed finding"))).toBe(false);
    const fresh = await builderContext(root, task, role, "fresh-session", sections(current), next.snapshot, { findings: current });
    expect(fresh.sections).toEqual(sections(current));
    const withoutRecords = { ...next.snapshot!, findingHashes: undefined };
    expect((await builderContext(root, task, role, "native-session", sections(current), withoutRecords, { findings: current })).sections).toEqual(sections(current));
    await writeFile(next.snapshot!.file, "Broken packet");
    expect((await builderContext(root, task, role, "native-session", sections(current), next.snapshot, { findings: current })).sections).toEqual(sections(current));
  } finally { removeDir(root); }
});

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
    const advanced = await builderContext(root, { ...task, baseSha: "new-main-version" }, role, "own-session", changed, next.snapshot);
    expect(advanced.sections.map((section) => section.title)).toEqual(["Current authoritative task context", changed[2]!.title]);
    expect(await readFile(advanced.snapshot!.file, "utf8")).toContain("base new-main-version");
    expect((await builderContext(root, { ...task, description: "A different request" }, role, "own-session", changed, next.snapshot)).sections).toEqual(changed);
    await rm(next.snapshot!.file);
    expect((await builderContext(root, task, role, "own-session", newBrief, next.snapshot)).sections).toEqual(newBrief);
    await writeFile(first.snapshot!.file, "Damaged context");
    expect((await builderContext(root, task, role, "own-session", changed, first.snapshot)).sections).toEqual(changed);
  } finally { removeDir(root); }
});

it("reuses unchanged context across companion base updates, but not a changed approved source", async () => {
  const root = tempDir("petrina-companion-context-");
  try {
    const task = createDemoState(1_000_000_000).tasks[0]!;
    const role = BUILT_IN_ROLES.find((entry) => entry.result === "build")!;
    const source = { product: { id: "api", name: "API", repo: "owner/api" }, start: { kind: "branch" as const, branch: "main" }, destination: { mode: "local" as const, kind: "branch" as const, repo: "owner/api", branch: "main" }, confirmed: true };
    const repository = { productId: "api", delivery: task.delivery, completedStages: [], source, baseSha: "old-main", worktree: "/copies/api" };
    const shared = { ...task, repositories: [repository] };
    const sections = [{ title: "Design brief", body: "Keep this requirement" }, { title: "Current product checks", body: "All passing on the new main" }];
    const first = await builderContext(root, shared, role, "same-session", sections);
    const advanced = { ...shared, repositories: [{ ...repository, baseSha: "new-main" }] };
    const next = await builderContext(root, advanced, role, "same-session", sections, first.snapshot);
    expect(next.sections.map((section) => section.title)).toEqual(["Current authoritative task context", "Current product checks"]);
    expect(await readFile(next.snapshot!.file, "utf8")).toContain("api: base new-main");
    const redirected = { ...advanced, repositories: [{ ...advanced.repositories[0]!, source: { ...source, start: { ...source.start, branch: "another-branch" } } }] };
    expect((await builderContext(root, redirected, role, "same-session", sections, next.snapshot)).sections).toEqual(sections);
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
