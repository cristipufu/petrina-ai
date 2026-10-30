// Content-addressed task files: each body is saved once under its digest. The name appears only after the
// complete body is written, so a caller saving the same body at the same moment never reads part of it.
// A different body under that name is rejected and kept, never replaced. Storage without hard links keeps
// each save's own complete copy under a private name instead.
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const absent = (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; };

/** Save the body as `<digest>.<suffix>` in the folder, or a private `<digest>.<id>.<suffix>` without hard links; a failed write leaves no new file. */
export async function saveImmutable(folder: string, suffix: string, body: string, changed: string): Promise<{ file: string; digest: string }> {
  const hash = digest(body);
  const file = join(folder, `${hash}.${suffix}`);
  const same = (text: string) => {
    if (digest(text) !== hash) throw new Error(changed);
    return { file, digest: hash };
  };
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const existing = await readFile(file, "utf8").catch(absent);
  if (existing !== undefined) return same(existing);
  // This caller's complete copy, under a name no other caller uses.
  const own = join(folder, `${hash}.${randomUUID()}.${suffix}`);
  let kept = false;
  try {
    await writeFile(own, body, { flag: "wx", mode: 0o600 });
    // A hard link takes the shared name only while it is free; a file that took it meanwhile is checked instead.
    try {
      await link(own, file);
      return { file, digest: hash };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return same(await readFile(file, "utf8"));
    }
    // Without hard links the shared name cannot be taken without risking replacing another file. A file
    // there now is checked the same way; otherwise this caller's own copy, still complete, is the saved file.
    const now = await readFile(file, "utf8").catch(absent);
    if (now !== undefined) return same(now);
    if (digest(await readFile(own, "utf8")) !== hash) throw new Error(changed);
    kept = true;
    return { file: own, digest: hash };
  } finally {
    // A copy left behind goes with the task's context folder.
    if (!kept) await rm(own, { force: true }).catch(() => {});
  }
}
