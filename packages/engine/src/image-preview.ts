import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Read on demand from the task's current working copy. Images are never copied or saved by Petrina. */
export async function readTaskImage(worktree: string | undefined, imagePath: string): Promise<{ mime: string; data: string }> {
  if (!worktree) throw new Error("This screenshot is no longer available: the task has no working copy.");
  if (!imagePath || imagePath.includes("\0")) throw new Error("This screenshot's location is not valid.");
  let location = imagePath;
  if (location.startsWith("file:")) {
    try { location = fileURLToPath(location); }
    catch { throw new Error("This screenshot's location is not valid."); }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(location) && !/^[a-z]:[\\/]/i.test(location)) {
    throw new Error("Only screenshots in this task's working copy can be previewed.");
  }
  let folder: string;
  let filename: string;
  try {
    folder = await realpath(worktree);
    filename = await realpath(resolve(folder, location));
  } catch { throw new Error("This screenshot is no longer available in the task's working copy."); }
  const inside = relative(folder, filename);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error("Only screenshots in this task's working copy can be previewed.");
  }
  const maxBytes = 8 * 1024 * 1024;
  const file = await open(filename, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("This screenshot is not an image file.");
    if (stat.size > maxBytes) throw new Error("This screenshot is too large to preview (8 MB maximum).");
    const bytes = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > maxBytes) throw new Error("This screenshot is too large to preview (8 MB maximum).");
    const data = bytes.subarray(0, size);
    const format = imageFormat(data);
    if (!format) throw new Error("This image cannot be previewed. Use a PNG, JPEG, GIF or WebP screenshot.");
    if (!format.width || !format.height || format.width * format.height > 16_000_000) {
      throw new Error("This screenshot's dimensions are too large to preview.");
    }
    return { mime: format.mime, data: data.toString("base64") };
  } finally { await file.close(); }
}

function imageFormat(data: Buffer): { mime: string; width: number; height: number } | undefined {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.toString("ascii", 12, 16) === "IHDR") {
    return { mime: "image/png", width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 10 && /^GIF8[79]a$/.test(data.toString("ascii", 0, 6))) {
    return { mime: "image/gif", width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (data.length >= 25 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") {
    const kind = data.toString("ascii", 12, 16);
    if (kind === "VP8X" && data.length >= 30) return { mime: "image/webp", width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
    if (kind === "VP8 " && data.length >= 30 && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) return { mime: "image/webp", width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L" && data[20] === 0x2f) {
      const packed = data.readUInt32LE(21);
      return { mime: "image/webp", width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
    }
  }
  if (data[0] !== 0xff || data[1] !== 0xd8) return;
  // JPEG frame headers carry dimensions before the compressed picture begins.
  for (let at = 2; at + 3 < data.length;) {
    if (data[at++] !== 0xff) return;
    while (data[at] === 0xff) at++;
    const marker = data[at++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) return;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > data.length) return;
    const length = data.readUInt16BE(at);
    if (length < 2 || at + length > data.length) return;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
      return { mime: "image/jpeg", width: data.readUInt16BE(at + 5), height: data.readUInt16BE(at + 3) };
    }
    at += length;
  }
}
