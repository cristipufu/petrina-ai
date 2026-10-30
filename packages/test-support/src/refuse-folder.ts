import { spyOn } from "bun:test";
import * as fs from "node:fs";
import * as files from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** A scoped native filesystem fault for an explicitly private runner-owned folder; callers restore in finally. */
export function refuseFolder(folder: string) {
  const standard = resolve(folder);
  const attempts: string[] = [];
  const refused = (path: unknown) => {
    const text = typeof path === "string" ? resolve(path) : path instanceof URL && path.protocol === "file:" ? resolve(fileURLToPath(path)) : "";
    if (text !== standard && !text.startsWith(standard + sep)) return undefined;
    attempts.push(text);
    return Object.assign(new Error(`EPERM: operation not permitted, '${text}'`), { code: "EPERM", path: text });
  };
  const spies: { mockRestore(): void }[] = [];
  const restore = () => {
    for (const spy of spies.reverse()) spy.mockRestore();
    spies.length = 0;
  };
  try {
    for (const name of ["mkdir", "mkdtemp", "writeFile", "rm"] as const) {
      const original = files[name] as (...args: unknown[]) => Promise<unknown>;
      const spy = spyOn(files, name);
      spies.push(spy);
      spy.mockImplementation((async (...args: unknown[]) => {
        const error = refused(args[0]);
        if (error) throw error;
        return original(...args);
      }) as never);
    }
    for (const name of ["mkdirSync", "mkdtempSync", "writeFileSync", "rmSync"] as const) {
      const original = fs[name] as (...args: unknown[]) => unknown;
      const spy = spyOn(fs, name);
      spies.push(spy);
      spy.mockImplementation(((...args: unknown[]) => {
        const error = refused(args[0]);
        if (error) throw error;
        return original(...args);
      }) as never);
    }
    return { attempts, restore };
  } catch (error) {
    restore();
    throw error;
  }
}
