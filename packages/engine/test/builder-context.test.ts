import { expectRejection } from "./rejections.js";
import { expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as files from "node:fs/promises";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { BUILT_IN_ROLES, createDemoState } from "@petrina/core";
import { builderContext } from "../src/builder-context.js";
import { saveExactMessage } from "../src/exact-input.js";
import { saveImmutable } from "../src/immutable-file.js";
import { formatFindings } from "../src/prompts.js";
import { Cleanup } from "../src/cleanup.js";
import { makeWorld, removeDir, tempDir } from "./support.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Holds the first text write under the folder once its first half is on disk, until released; every other write runs normally. */
function holdFirstWrite(folder: string) {
  const write = files.writeFile;
  let reached!: () => void, release!: () => void;
  const partial = new Promise<void>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const held: string[] = [];
  const spy = spyOn(files, "writeFile").mockImplementation(async (path, data, options) => {
    if (held.length || typeof data !== "string" || !String(path).startsWith(folder)) return write(path, data, options);
    held.push(String(path));
    await write(path, data.slice(0, data.length / 2), options);
    reached();
    await released;
    await files.appendFile(path, data.slice(data.length / 2));
  });
  return { partial, release, held, restore: () => { release(); spy.mockRestore(); } };
}

it("publishes a complete packet before a second seat saving the same instructions reads it, so each seat keeps its own context", async () => {
  const root = tempDir("context-simultaneous-seats-");
  const hold = holdFirstWrite(root);
  try {
    const task = createDemoState(1_000_000_000).tasks[0]!;
    const role = BUILT_IN_ROLES.find(entry => entry.id === "code-reviewer")!;
    const sections = [{ title: "Design brief", body: "A complete requirement. ".repeat(10_000) }];
    const pending = builderContext(root, task, role, "seat-0", sections);
    await Promise.race([hold.partial, pending]);
    expect(hold.held).toHaveLength(1);
    // The first seat's exclusive write is held halfway with its partial bytes on disk.
    const second = await builderContext(root, task, role, "seat-1", sections);
    expect(second.sections).toEqual(sections);
    expect(second.snapshot).toBeDefined();
    expect(sha(await readFile(second.snapshot!.file, "utf8"))).toBe(second.snapshot!.digest);
    hold.release();
    const first = await pending;
    expect(first.sections).toEqual(sections);
    expect(first.snapshot).toMatchObject({ file: second.snapshot!.file, digest: second.snapshot!.digest });
    expect(first.snapshot!.scope).not.toBe(second.snapshot!.scope);
    expect(sha(await readFile(first.snapshot!.file, "utf8"))).toBe(first.snapshot!.digest);
    expect(await readdir(dirname(first.snapshot!.file))).toEqual([basename(first.snapshot!.file)]);
    // Each seat continues only its own conversation from the shared packet.
    for (const [session, own, other] of [["seat-0", first, second], ["seat-1", second, first]] as const) {
      expect((await builderContext(root, task, role, session, sections, own.snapshot)).sections.map(section => section.title)).toEqual(["Current authoritative task context"]);
      expect((await builderContext(root, task, role, session, sections, other.snapshot)).sections).toEqual(sections);
    }
  } finally { hold.restore(); removeDir(root); }
});

it("keeps both seats' packets when they save one after another, or save different instructions at the same moment", async () => {
  const root = tempDir("context-seat-controls-");
  const task = createDemoState(1_000_000_000).tasks[0]!;
  const role = BUILT_IN_ROLES.find(entry => entry.id === "code-reviewer")!;
  const sections = (body: string) => [{ title: "Design brief", body: body.repeat(10_000) }];
  try {
    const one = await builderContext(root, task, role, "seat-0", sections("Shared. "));
    const two = await builderContext(root, task, role, "seat-1", sections("Shared. "));
    expect(one.snapshot!.file).toBe(two.snapshot!.file);
    expect(one.snapshot!.scope).not.toBe(two.snapshot!.scope);
    const hold = holdFirstWrite(root);
    try {
      const pending = builderContext(root, task, role, "seat-0", sections("First seat's. "));
      await Promise.race([hold.partial, pending]);
      const other = await builderContext(root, task, role, "seat-1", sections("Second seat's. "));
      hold.release();
      const first = await pending;
      expect(first.snapshot!.file).not.toBe(other.snapshot!.file);
      for (const result of [first, other]) expect(sha(await readFile(result.snapshot!.file, "utf8"))).toBe(result.snapshot!.digest);
    } finally { hold.restore(); }
  } finally { removeDir(root); }
});

it("leaves no partial packet or temporary file after a failed write, sends complete instructions and saves the packet next time", async () => {
  const root = tempDir("context-failed-write-");
  const task = createDemoState(1_000_000_000).tasks[0]!;
  const role = BUILT_IN_ROLES.find(entry => entry.id === "code-reviewer")!;
  const sections = [{ title: "Design brief", body: "Keep the complete requirement. ".repeat(1_000) }];
  const folder = join(root, "contexts", task.id);
  const write = files.writeFile;
  try {
    const failing = spyOn(files, "writeFile").mockImplementation(async (path, data, options) => { await write(path, String(data).slice(0, 100), options); throw new Error("The disk filled up"); });
    try {
      const failed = await builderContext(root, task, role, "own-review", sections);
      expect(failed.sections).toEqual(sections);
      expect(failed.snapshot).toBeUndefined();
      expect(await readdir(folder)).toEqual([]);
    } finally { failing.mockRestore(); }
    const saved = await builderContext(root, task, role, "own-review", sections);
    expect(sha(await readFile(saved.snapshot!.file, "utf8"))).toBe(saved.snapshot!.digest);
    expect(await readdir(folder)).toEqual([basename(saved.snapshot!.file)]);
  } finally { removeDir(root); }
});

/** Storage without hard links, answering as a real exFAT volume does: a taken name exists, a free one is unsupported. */
const noHardLinks = (afterRefusal?: (to: string) => Promise<void>) => spyOn(files, "link").mockImplementation(async (_from, to) => {
  if (await access(to).then(() => true, () => false)) throw Object.assign(new Error("The name is taken"), { code: "EEXIST" });
  await afterRefusal?.(String(to));
  throw Object.assign(new Error("Hard links are not supported here"), { code: "ENOTSUP" });
});

it("keeps each seat's own complete packet where storage has no hard links, without ever writing the shared name", async () => {
  const root = tempDir("context-without-links-");
  const task = createDemoState(1_000_000_000).tasks[0]!;
  const role = BUILT_IN_ROLES.find(entry => entry.id === "code-reviewer")!;
  const sections = [{ title: "Design brief", body: "Keep the complete requirement. ".repeat(1_000) }];
  let unsupported = noHardLinks();
  try {
    const hold = holdFirstWrite(root);
    let shared: string;
    try {
      const pending = builderContext(root, task, role, "seat-0", sections);
      await Promise.race([hold.partial, pending]);
      expect(hold.held).toHaveLength(1);
      const second = await builderContext(root, task, role, "seat-1", sections);
      hold.release();
      const first = await pending;
      expect(first.snapshot!.digest).toBe(second.snapshot!.digest);
      expect(first.snapshot!.file).not.toBe(second.snapshot!.file);
      for (const result of [first, second]) expect(sha(await readFile(result.snapshot!.file, "utf8"))).toBe(result.snapshot!.digest);
      shared = join(dirname(first.snapshot!.file), `${first.snapshot!.digest}.md`);
      expect(await readdir(dirname(shared))).not.toContain(basename(shared));
      for (const [session, own, other] of [["seat-0", first, second], ["seat-1", second, first]] as const) {
        expect((await builderContext(root, task, role, session, sections, own.snapshot)).sections.map(section => section.title)).toEqual(["Current authoritative task context"]);
        expect((await builderContext(root, task, role, session, sections, other.snapshot)).sections).toEqual(sections);
      }
    } finally { hold.restore(); }
    // A complete copy already under the shared name is used; a different file there is refused and kept.
    const packet = await readFile((await builderContext(root, task, role, "seat-0", sections)).snapshot!.file, "utf8");
    for (const content of [packet, "A different packet"]) {
      await writeFile(shared, content);
      const result = await builderContext(root, task, role, "seat-0", sections);
      expect(result.sections).toEqual(sections);
      expect(result.snapshot?.file).toBe(content === "A different packet" ? undefined : shared);
      expect(await readFile(shared, "utf8")).toBe(content);
    }
    unsupported.mockRestore();
    // The same complete copy taking the shared name just after the refusal is used, and this save's private copy goes.
    await rm(shared);
    const before = await readdir(dirname(shared));
    unsupported = noHardLinks(async (to) => { await writeFile(to, packet); });
    expect((await builderContext(root, task, role, "seat-0", sections)).snapshot?.file).toBe(shared);
    expect((await readdir(dirname(shared))).sort()).toEqual([...before, basename(shared)].sort());
    unsupported.mockRestore();
    // A folder removed during the save leaves no reference to the private copy that went with it.
    await rm(shared);
    unsupported = spyOn(files, "link").mockImplementation(async (from) => {
      await rm(dirname(String(from)), { recursive: true, force: true });
      throw Object.assign(new Error("The folder is gone"), { code: "ENOENT" });
    });
    const gone = await builderContext(root, task, role, "seat-0", sections);
    expect(gone.sections).toEqual(sections);
    expect(gone.snapshot).toBeUndefined();
  } finally { unsupported.mockRestore(); removeDir(root); }
});

for (const timing of ["during the write", "during the write, on storage without hard links", "after storage refuses a hard link"] as const) it(`rejects and keeps a different file that appears under the shared name ${timing}, for instructions, a message and review material`, async () => {
  const root = tempDir("context-damage-during-save-");
  const task = createDemoState(1_000_000_000).tasks[0]!;
  const role = BUILT_IN_ROLES.find(entry => entry.id === "code-reviewer")!;
  const sections = [{ title: "Design brief", body: "Keep the complete requirement. ".repeat(1_000) }];
  const changed = "The saved review material changed. Try the review again.";
  const saves = [
    { suffix: "md", save: () => builderContext(root, task, role, "own-review", sections).then(result => { expect(result.sections).toEqual(sections); return result.snapshot; }) },
    { suffix: "md", save: () => saveExactMessage(root, task.id, "The exact instructions. ".repeat(1_000)) },
    { suffix: "full.md", save: () => saveImmutable(join(root, "contexts", task.id, "reviews"), "full.md", "Review material. ".repeat(1_000), changed).catch((error: Error) => { expect(error.message).toBe(changed); return undefined; }) },
  ];
  let shared: string | undefined;
  const late = timing === "after storage refuses a hard link";
  const unsupported = timing === "during the write" ? undefined : noHardLinks(late ? async (to) => { shared = to; await writeFile(to, "Damaged content"); } : undefined);
  try {
    for (const { suffix, save } of saves) {
      shared = undefined;
      const hold = late ? undefined : holdFirstWrite(root);
      try {
        const pending = save();
        if (hold) {
          // The save already found the shared name free; the damage lands before its complete copy is named.
          await Promise.race([hold.partial, pending]);
          expect(hold.held).toHaveLength(1);
          shared = join(dirname(hold.held[0]!), `${basename(hold.held[0]!).split(".")[0]}.${suffix}`);
          await writeFile(shared, "Damaged content");
          hold.release();
        }
        expect(await pending).toBeUndefined();
        expect(await readFile(shared!, "utf8")).toBe("Damaged content");
        const [hash] = basename(shared!).split(".");
        expect((await readdir(dirname(shared!))).filter(name => name.startsWith(hash!))).toEqual([basename(shared!)]);
      } finally { hold?.restore(); }
    }
  } finally { unsupported?.mockRestore(); removeDir(root); }
});

it("references a saved exact message only once its complete text is on disk", async () => {
  const root = tempDir("exact-message-publication-");
  const text = "The exact instructions. ".repeat(10_000);
  try {
    const hold = holdFirstWrite(root);
    try {
      const pending = saveExactMessage(root, "task-1", text);
      await Promise.race([hold.partial, pending]);
      expect(hold.held).toHaveLength(1);
      const second = await saveExactMessage(root, "task-1", text);
      expect(second).toMatchObject({ digest: sha(text), size: text.length });
      expect(await readFile(second!.file, "utf8")).toBe(text);
      hold.release();
      expect(await pending).toEqual(second);
    } finally { hold.restore(); }
    const write = files.writeFile;
    const failing = spyOn(files, "writeFile").mockImplementation(async (path, data, options) => { await write(path, String(data).slice(0, 100), options); throw new Error("The disk filled up"); });
    try {
      expect(await saveExactMessage(root, "task-2", text)).toBeUndefined();
      expect(await readdir(join(root, "contexts", "task-2", "messages"))).toEqual([]);
    } finally { failing.mockRestore(); }
    const saved = await saveExactMessage(root, "task-2", text);
    expect(await readFile(saved!.file, "utf8")).toBe(text);
    // A different text already under the name gets no reference and is never replaced.
    await writeFile(saved!.file, "A damaged message");
    expect(await saveExactMessage(root, "task-2", text)).toBeUndefined();
    expect(await readFile(saved!.file, "utf8")).toBe("A damaged message");
  } finally { removeDir(root); }
});

it("keeps complete instructions without a saved packet when context storage is unavailable, and recovers when it returns", async () => {
  const root = tempDir("context-storage-unavailable-");
  try {
    const task = createDemoState(1_000_000_000).tasks[0]!;
    const role = BUILT_IN_ROLES.find(entry => entry.id === "code-reviewer")!;
    const sections = [{ title: "Design brief", body: "Keep the complete requirement." }];
    // A file in place of the packet directory makes storage fail without touching other tests.
    const blocked = join(root, "contexts");
    await writeFile(blocked, "Unavailable context storage");
    const unavailable = await builderContext(root, task, role, "own-review", sections);
    expect(unavailable.sections).toEqual(sections);
    expect(unavailable.snapshot).toBeUndefined();
    await rm(blocked);
    const recovered = await builderContext(root, task, role, "own-review", sections);
    expect(recovered.sections).toEqual(sections);
    expect(await readFile(recovered.snapshot!.file, "utf8")).toContain(sections[0]!.body);
    const continued = await builderContext(root, task, role, "own-review", sections, recovered.snapshot);
    expect(continued.sections.map(section => section.title)).toEqual(["Current authoritative task context"]);
  } finally { removeDir(root); }
});

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
    // macOS and Linux keep the saved context to its owner. Windows has no owner-only mode bits: its
    // mode says only whether a file is read-only, and the saved context is an ordinary writable file.
    expect((await stat(next.snapshot!.file)).mode & 0o777).toBe(process.platform === "win32" ? 0o666 : 0o600);

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
  const world = await makeWorld("builder-context-cleanup");
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
    await expectRejection(access(join(world.data, "contexts", finished)));
    await expectRejection(access(join(world.data, "contexts", "orphaned-context")));
  } finally { await engine.shutdown(); removeDir(world.dir); }
});
