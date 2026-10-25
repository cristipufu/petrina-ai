import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { constants, lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync, type PathLike } from "node:fs";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReportImage } from "@petrina/core";

export function inside(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Automatic browser output must still use the original capture directory. */
export async function captureDirectory(root: string): Promise<string> {
  return captureRoot(root);
}

function captureRoot(root: string): string {
  // The last step is checked on its own. A shortcut placed over the capture folder is not a directory.
  if (!lstatSync(root).isDirectory()) throw new Error("Browser output cannot replace its capture folder with a link.");
  return realpathSync(root);
}

/** Resolve a capture name without following a shortcut. */
export async function capturePath(root: string, filename: string): Promise<string> {
  return capturePathSync(root, filename);
}

/**
 * A picture is safe only as a real file inside the capture folder. Shortcuts are refused
 * instead of followed: a name that stays in the folder can still lead through another
 * shortcut, or through a shared file, and reading or writing it would use a product file.
 * Each step is checked on its own, because stating the whole path follows every shortcut but the last.
 */
function capturePathSync(root: string, filename: string): string {
  const base = captureRoot(root);
  const requested = resolve(root, filename);
  // Keep the caller's spelling of the capture folder. On macOS /tmp is a link to
  // /private/tmp, and a download path may use either spelling of the same folder.
  const target = inside(root, requested) ? resolve(base, relative(root, requested)) : requested;
  if (!inside(base, target)) throw new Error("Save browser output inside this session's capture folder.");
  const parts = relative(base, target).split(sep).filter((part) => part && part !== ".");
  let dir = base;
  for (let index = 0; index < parts.length; index += 1) {
    const current = resolve(dir, parts[index]!);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
    if (stat.isSymbolicLink()) throw new Error("Browser output cannot follow a link outside its capture folder.");
    const last = index === parts.length - 1;
    if (!last) {
      if (!stat.isDirectory()) throw new Error("Browser output cannot follow a link outside its capture folder.");
      dir = current;
      continue;
    }
    if (!stat.isFile()) throw new Error("Browser output cannot follow a link outside its capture folder.");
    if (stat.nlink > 1) throw new Error("Browser output cannot overwrite a linked file.");
  }
  const destination = resolve(root, relative(base, target));
  mkdirSync(dirname(destination), { recursive: true });
  return destination;
}

function literalInside(root: string, file: string): boolean {
  const requested = resolve(file);
  if (inside(root, requested)) return true;
  try {
    const base = realpathSync(root);
    if (inside(base, requested)) return true;
    const ancestor = existingAncestor(dirname(requested));
    return ancestor === base || inside(base, ancestor);
  } catch {
    return false;
  }
}

function existingAncestor(path: string): string {
  let current = path;
  for (;;) {
    try { return realpathSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

const requireFs = createRequire(import.meta.url);

/**
 * Page downloads and other automatic output never pass a tool filename, and the
 * browser would follow a shortcut already in the capture folder. Check every capture
 * write in this process before it happens, and refuse a shortcut or a shared file.
 * A replacement is written beside the destination and renamed into place, which does
 * not follow a shortcut. Writes elsewhere are left alone so the browser's own cache still works.
 */
export function guardCaptureWrites(root: string): () => void {
  const modules = [requireFs("fs"), requireFs("node:fs")].filter((fs, index, all) => all.indexOf(fs) === index);
  const originals = modules.map((fs) => ({
    fs,
    writeFile: fs.promises.writeFile,
    appendFile: fs.promises.appendFile,
    copyFile: fs.promises.copyFile,
    createWriteStream: fs.createWriteStream,
  }));
  const screen = (file: unknown) => {
    const path = writePath(file);
    if (path !== undefined && literalInside(root, path)) capturePathSync(root, path);
  };
  const replace = async (destination: string, write: (temporary: string) => Promise<void>) => {
    const temporary = `${destination}.${randomUUID()}.part`;
    try {
      await write(temporary);
      renameSync(temporary, destination);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* The temporary file was never created. */ }
      throw error;
    }
  };
  for (const saved of originals) {
    const promises = saved.fs.promises;
    const writeFile = saved.writeFile as (file: PathLike, ...rest: unknown[]) => ReturnType<typeof saved.writeFile>;
    const appendFile = saved.appendFile as (file: PathLike, ...rest: unknown[]) => ReturnType<typeof saved.appendFile>;
    const copyFile = saved.copyFile as (source: PathLike, destination: PathLike, ...rest: unknown[]) => ReturnType<typeof saved.copyFile>;
    const createWriteStream = saved.createWriteStream as (file: PathLike, ...rest: unknown[]) => ReturnType<typeof saved.createWriteStream>;
    promises.writeFile = (async (file: PathLike, ...rest: unknown[]) => {
      const path = writePath(file);
      // The second argument is the contents. Only the options after it can ask to append.
      if (path === undefined || !literalInside(root, path) || appends(rest[1])) {
        if (path !== undefined) screen(file);
        return writeFile(file, ...rest);
      }
      capturePathSync(root, path);
      await replace(path, (temporary) => Promise.resolve(writeFile(temporary, ...rest)));
    }) as typeof promises.writeFile;
    promises.appendFile = (async (file: PathLike, ...rest: unknown[]) => {
      screen(file);
      return appendFile(file, ...rest);
    }) as typeof promises.appendFile;
    promises.copyFile = (async (source: PathLike, destination: PathLike, ...rest: unknown[]) => {
      const path = writePath(destination);
      if (path === undefined || !literalInside(root, path)) return copyFile(source, destination, ...rest);
      capturePathSync(root, path);
      await replace(path, (temporary) => Promise.resolve(copyFile(source, temporary, ...rest)));
    }) as typeof promises.copyFile;
    saved.fs.createWriteStream = ((file: PathLike, ...rest: unknown[]) => {
      screen(file);
      return createWriteStream(file, ...rest);
    }) as typeof saved.fs.createWriteStream;
  }
  return () => {
    for (const saved of originals) {
      saved.fs.promises.writeFile = saved.writeFile;
      saved.fs.promises.appendFile = saved.appendFile;
      saved.fs.promises.copyFile = saved.copyFile;
      saved.fs.createWriteStream = saved.createWriteStream;
    }
  };
}

function appends(option: unknown): boolean {
  const flag = typeof option === "string" ? option : option && typeof option === "object" && "flag" in option ? String((option as { flag?: unknown }).flag ?? "") : "";
  return /^(a|ax|as|a\+|ax\+|as\+)$/.test(flag);
}

function writePath(file: unknown): string | undefined {
  if (typeof file === "string") return file;
  if (file instanceof URL) return fileURLToPath(file);
  return undefined;
}

/** Decode before copying. State carries opaque references, never paths or image bytes. */
export async function preserveCaptures(root: string, storage: string, images: readonly { path: string; caption: string }[], signal?: AbortSignal): Promise<ReportImage[]> {
  signal?.throwIfAborted();
  if (!images.length) return [];
  const { default: sharp } = await import("sharp");
  const validated: { bytes: Buffer; caption: string }[] = [];
  for (const image of images) {
    signal?.throwIfAborted();
    if (!image.caption.trim()) throw new Error("Every chosen picture needs a plain-language caption.");
    try {
      const path = await capturePath(root, image.path);
      // Open the file itself. A shortcut here is an error, not a way through to another file.
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      let bytes: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 20 * 1024 * 1024) throw new Error("not a readable image");
        bytes = Buffer.from(await handle.readFile());
      } finally {
        await handle.close();
      }
      const decoder = sharp(bytes, { limitInputPixels: 40_000_000, failOn: "warning" });
      const metadata = await decoder.metadata();
      if (!["png", "jpeg", "webp"].includes(metadata.format ?? "")) throw new Error("unsupported image");
      // Re-encode to remove metadata and ensure the entire image really decodes.
      validated.push({ bytes: await decoder.png().toBuffer(), caption: image.caption.trim() });
    } catch {
      throw new Error(`The chosen picture “${image.path}” must be a readable PNG, JPEG or WebP inside this session's capture folder. Take it again there, or leave it out.`);
    }
  }
  signal?.throwIfAborted();
  await mkdir(storage, { recursive: true, mode: 0o700 });
  const saved: ReportImage[] = [];
  try {
    for (const image of validated) {
      signal?.throwIfAborted();
      const id = randomUUID();
      // Include an interrupted/partial write in cleanup too.
      saved.push({ id, caption: image.caption });
      try {
        await writeFile(resolve(storage, `${id}.png`), image.bytes, { flag: "wx", mode: 0o600, signal });
      } catch (error) {
        // An exclusive-write refusal did not create this file, so it is not ours to remove.
        if ((error as NodeJS.ErrnoException).code === "EEXIST") saved.pop();
        throw error;
      }
      signal?.throwIfAborted();
    }
    return saved;
  } catch (error) {
    await Promise.all(saved.map((image) => rm(resolve(storage, `${image.id}.png`), { force: true })));
    throw error;
  }
}
