import { dlopen, FFIType, ptr } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve, toNamespacedPath } from "node:path";

/** Read completed fixture records while a child may still be appending the last line. */
export function readFixtureJsonLines<T = unknown>(path: string): T[] {
  let body: string;
  try { body = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
    throw error;
  }
  const end = body.lastIndexOf("\n");
  if (end < 0) return [];
  // A complete malformed record must fail; only the not-yet-terminated tail is pending.
  return body.slice(0, end).split("\n").map(line => JSON.parse(line) as T);
}

interface Kernel32PosixRename {
  CreateFileW(
    name: ReturnType<typeof ptr>,
    access: number,
    share: number,
    security: ReturnType<typeof ptr> | null,
    disposition: number,
    flags: number,
    template: ReturnType<typeof ptr> | null,
  ): bigint;
  SetFileInformationByHandle(handle: bigint, infoClass: number, info: ReturnType<typeof ptr>, size: number): number;
  CloseHandle(handle: bigint): number;
}

let kernel32: { symbols: Kernel32PosixRename } | undefined;

function isDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

/**
 * Windows MoveFileExW without FILE_RENAME_FLAG_POSIX_SEMANTICS refuses to replace a file that a
 * live reader currently holds open, even when opened with FILE_SHARE_DELETE. Use FileRenameInfoEx
 * with POSIX semantics so open readers stay on the old file while new readers see the replacement.
 */
function posixRenameWindows(source: string, destination: string): boolean {
  kernel32 ??= dlopen("kernel32.dll", {
    CreateFileW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.i64,
    },
    SetFileInformationByHandle: {
      args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
  }) as unknown as { symbols: Kernel32PosixRename };
  const sourceWide = Buffer.from(`${toNamespacedPath(resolve(source))}\0`, "utf16le");
  // DELETE | SYNCHRONIZE = 0x00110000, FILE_SHARE_READ | WRITE | DELETE = 0x7, OPEN_EXISTING = 3.
  const handle = kernel32.symbols.CreateFileW(ptr(sourceWide), 0x00110000, 0x7, null, 3, 0x80, null);
  if (handle === -1n || handle === 0n) return false;
  try {
    const destWide = Buffer.from(toNamespacedPath(resolve(destination)), "utf16le");
    const x64 = process.arch === "x64" || process.arch === "arm64";
    const headerSize = x64 ? 20 : 12;
    const minSize = x64 ? 24 : 16;
    const infoSize = Math.max(minSize, headerSize + destWide.byteLength + 2);
    const info = Buffer.alloc(infoSize);
    // FILE_RENAME_FLAG_REPLACE_IF_EXISTS (0x1) | FILE_RENAME_FLAG_POSIX_SEMANTICS (0x2) = 0x3.
    info.writeUInt32LE(0x3, 0);
    info.writeUInt32LE(destWide.byteLength, x64 ? 16 : 8);
    destWide.copy(info, headerSize);
    // FileRenameInfoEx = 22.
    return kernel32.symbols.SetFileInformationByHandle(handle, 22, ptr(info), infoSize) !== 0;
  } finally {
    kernel32.symbols.CloseHandle(handle);
  }
}

/** Publish complete fixture configuration to live child readers, preserving the old file on failure. */
export function writeFixtureJson(path: string, value: unknown, spaces?: number): void {
  const body = JSON.stringify(value, null, spaces);
  if (body === undefined) throw new Error("Fixture configuration must be a JSON value.");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
    try {
      renameSync(temporary, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      const canPosixReplace =
        process.platform === "win32" && (code === "EPERM" || code === "EACCES") && !isDirectory(path);
      if (!canPosixReplace || !posixRenameWindows(temporary, path)) throw error;
    }
  } finally { rmSync(temporary, { force: true }); }
}
