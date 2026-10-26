import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { legacyDeliveryAgents } from "./legacy-delivery-agents.js";
import type { World } from "../support.js";

/** Cleanup owns real repositories/files/history; provider transport is controlled in these boundary cases. */
export function cleanupAgents(world: World) {
  const agents = legacyDeliveryAgents(world), start = agents.startAgentSession;
  return { ...agents, startAgentSession: ((options, role) => {
    if (role.result === "build") cleanupBuildOutput(world, options.cwd);
    return start(options, role);
  }) as typeof start };
}

export function cleanupBuildOutput(world: Pick<World, "script">, cwd: string): void {
  const installs = world.script().installs;
  if (installs) {
      mkdirSync(join(cwd, "node_modules", "left-pad"), { recursive: true });
      writeFileSync(join(cwd, "node_modules", "left-pad", "index.js"), "module.exports = (text) => text;\n");
      mkdirSync(join(cwd, "target", "debug"), { recursive: true });
      writeFileSync(join(cwd, "target", "debug", "greeting.bin"), "build output\n");
      if (!existsSync(join(cwd, "node_modules", ".cache"))) fixtureFiles.directoryLink(installs.cache, join(cwd, "node_modules", ".cache"));
    }
}
