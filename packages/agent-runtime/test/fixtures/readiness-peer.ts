import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Private native login observations, without the Engine workflow fixture. */
export function readinessPeer(dir: string) {
  mkdirSync(dir, { recursive: true });
  const records = (name: string): unknown[] => {
    const path = join(dir, name);
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  return { dir, command: (login: "none" | "silent") => [process.execPath, join(import.meta.dir, "readiness-agent.ts"), dir, login],
    opens: () => records("opens.jsonl"), prompts: () => records("prompts.jsonl"),
  };
}
