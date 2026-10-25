import { expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as files from "node:fs/promises";
import { access, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { BUILT_IN_ROLES } from "@petrina/core";
import { builderContext } from "../../../src/builder-context.js";
import { saveExactMessage } from "../../../src/exact-input.js";
import { saveImmutable } from "../../../src/immutable-file.js";
import { removeDir, tempDir } from "../../support.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

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

const noHardLinks = (afterRefusal?: (to: string) => Promise<void>) => spyOn(files, "link").mockImplementation(async (_from, to) => {
  if (await access(to).then(() => true, () => false)) throw Object.assign(new Error("The name is taken"), { code: "EEXIST" });
  await afterRefusal?.(String(to));
  throw Object.assign(new Error("Hard links are not supported here"), { code: "ENOTSUP" });
});
import { promptTask } from "../../fixtures/prompt-context.js";

it("publishes a complete packet before a second seat saving the same instructions reads it, so each seat keeps its own context", async () => {
  const root = tempDir("context-simultaneous-seats-");
  const hold = holdFirstWrite(root);
  try {
    const task = promptTask();
    const role = BUILT_IN_ROLES.find(entry => entry.id === "code-reviewer")!;
    const sections = [{ title: "Design brief", body: "A complete requirement. ".repeat(10_000) }, { title: "The coordinator's notes on this task", body: "", background: "Queued guidance delivered separately in the prompt." }];
    const supplied = [sections[0]!];
    const pending = builderContext(root, task, role, "seat-0", sections);
    await Promise.race([hold.partial, pending]);
    expect(hold.held).toHaveLength(1);
    // The first seat's exclusive write is held halfway with its partial bytes on disk.
    const second = await builderContext(root, task, role, "seat-1", sections);
    expect(second.sections).toEqual(supplied);
    expect(second.snapshot).toBeDefined();
    expect(sha(await readFile(second.snapshot!.file, "utf8"))).toBe(second.snapshot!.digest);
    expect(await readFile(second.snapshot!.file, "utf8")).toContain(sections[1]!.background!);
    hold.release();
    const first = await pending;
    expect(first.sections).toEqual(supplied);
    expect(first.snapshot).toMatchObject({ file: second.snapshot!.file, digest: second.snapshot!.digest });
    expect(first.snapshot!.scope).not.toBe(second.snapshot!.scope);
    expect(sha(await readFile(first.snapshot!.file, "utf8"))).toBe(first.snapshot!.digest);
    expect(await readdir(dirname(first.snapshot!.file))).toEqual([basename(first.snapshot!.file)]);
    // Each seat continues only its own conversation from the shared packet. Once
    // delivered, the queued guidance stays background rather than another prompt copy.
    const heard = [sections[0]!, { ...sections[1]!, body: sections[1]!.background! }];
    for (const [session, own, other] of [["seat-0", first, second], ["seat-1", second, first]] as const) {
      expect((await builderContext(root, task, role, session, heard, own.snapshot)).sections.map(section => section.title)).toEqual(["Current authoritative task context"]);
      expect((await builderContext(root, task, role, session, heard, other.snapshot)).sections).toEqual(heard);
    }
  } finally { hold.restore(); removeDir(root); }
});

it("keeps both seats' packets when they save one after another, or save different instructions at the same moment", async () => {
  const root = tempDir("context-seat-controls-");
  const task = promptTask();
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
  const task = promptTask();
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

it("keeps each seat's own complete packet where storage has no hard links, without ever writing the shared name", async () => {
  const root = tempDir("context-without-links-");
  const task = promptTask();
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
  const task = promptTask();
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
    const task = promptTask();
    const role = BUILT_IN_ROLES.find(entry => entry.id === "code-reviewer")!;
    const sections = [{ title: "Design brief", body: "Keep the complete requirement." }, { title: "The coordinator's notes on this task", body: "", background: "An instruction supplied separately in the prompt." }];
    // A file in place of the packet directory makes storage fail without touching other tests.
    const blocked = join(root, "contexts");
    await writeFile(blocked, "Unavailable context storage");
    const unavailable = await builderContext(root, task, role, "own-review", sections);
    expect(unavailable.sections).toEqual([sections[0]!]);
    expect(unavailable.snapshot).toBeUndefined();
    await rm(blocked);
    const recovered = await builderContext(root, task, role, "own-review", sections);
    expect(recovered.sections).toEqual([sections[0]!]);
    expect(await readFile(recovered.snapshot!.file, "utf8")).toContain(sections[0]!.body);
    expect(await readFile(recovered.snapshot!.file, "utf8")).toContain(sections[1]!.background!);
    const heard = [sections[0]!, { ...sections[1]!, body: sections[1]!.background! }];
    const continued = await builderContext(root, task, role, "own-review", heard, recovered.snapshot);
    expect(continued.sections.map(section => section.title)).toEqual(["Current authoritative task context"]);
    expect((await builderContext(root, task, role, "replacement", heard, continued.snapshot)).sections).toEqual(heard);
    expect((await builderContext(root, { ...task, id: "invalid/id" }, role, "fresh", sections)).sections).toEqual([sections[0]!]);
  } finally { removeDir(root); }
});
