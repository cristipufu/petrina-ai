import { createRequire } from "node:module";
import { resolve } from "node:path";

/** Resolve through the browser adapter's actual locked dependency, without loading it for CLI help. */
export function bundledChromiumExecutablePath(): string {
  const runtime = createRequire(resolve(import.meta.dir, "../../../agent-runtime/package.json"));
  const bundled = createRequire(runtime.resolve("@playwright/mcp/package.json"));
  const { chromium } = bundled("playwright-core") as { chromium: { executablePath(): string } };
  return chromium.executablePath();
}
