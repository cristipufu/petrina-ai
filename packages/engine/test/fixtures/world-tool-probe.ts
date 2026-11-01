import type { ToolProbe } from "@petrina/orchestrator";
import { gitHubReadiness } from "@petrina/repositories/tool-readiness";
import { fakeGitHubRequest } from "../fake-gh.js";
import { join } from "node:path";
import { privateAgentToolProbe } from "../scripted-probes.js";

/** Explicit private participant availability; the world's account remains an actual scripted-service observation. */
export function privateWorldToolProbe(world: { dir: string; remote: string }, ready?: Parameters<typeof privateAgentToolProbe>[0]): ToolProbe {
  const agents = privateAgentToolProbe(ready);
  return worldToolProbe(join(world.dir, "github.json"), world.remote, () => agents);
}

/** Only this world's scripted GitHub account uses supplied observations; every other probe stays native. */
export function worldToolProbe(state: string, remote: string, native: () => ToolProbe): ToolProbe {
  return {
    absent: id => id === "gh" ? false : native().absent(id),
    async run(id, request) {
      if (id !== "gh") return native().run(id, request);
      request.signal.throwIfAborted();
      try {
        const pending = fakeGitHubRequest(state, remote, ["auth", "status", "--hostname", "github.com"]);
        request.onGone(pending.then(() => undefined, () => undefined));
        const observed = await pending;
        return gitHubReadiness({ ...observed, stdout: observed.stdout.trim(), stderr: observed.stderr.trim() });
      } catch (error) {
        // Match the explicit CLI stand-in's failed-command response, never a successful account observation.
        return gitHubReadiness({ code: 1, stdout: "", stderr: `fake gh could not answer: ${error instanceof Error ? error.message : String(error)}` });
      }
    },
  };
}
