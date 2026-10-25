import { builtinModules } from "node:module";
import type { ImpactRuntime } from "./impact.js";

/** Read at each source boundary: a changed execution environment invalidates prior evidence. */
export function impactRuntime(): ImpactRuntime {
  return { identity: { bun: Bun.version, platform: process.platform, arch: process.arch, ci: process.env.CI ?? "", browser: process.env.PETRINA_BROWSER_CHECK ?? "" }, builtinModules };
}
