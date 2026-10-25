// Delivery tests need capture-folder bookkeeping, without a browser or another server.
import { spyOn } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentBrowser } from "@petrina/agent-runtime/browser";

export function standInBrowser() {
  return spyOn(AgentBrowser, "start").mockImplementation(async parent => {
    if (!parent) throw new Error("This fixture expects an owned browser registry");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "capture-"));
    return { directory, mcp: { type: "http", name: "fake-browser", url: "http://127.0.0.1:1", headers: [] }, close: () => rm(directory, { recursive: true, force: true }) } as unknown as AgentBrowser;
  });
}
