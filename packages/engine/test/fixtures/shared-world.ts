import { join } from "node:path";
import { completeAll } from "@petrina/core";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import type { EngineOptions } from "../engine.js";
import { Fakes, makeWorld, type World } from "../support.js";
import { sharedAgents } from "./shared-agents.js";
import { scriptedToolProbe } from "../scripted-probes.js";

async function products(name: string, worlds: World[]) {
  const [shop, api] = await completeAll([
    { name: `shared-shop-${name}` }, { name: `shared-api-${name}`, address: "https://github.com/acme/api.git" },
  ].map(async ({ name: label, address }) => { const world = await makeWorld(label, { address }); worlds.push(world); return world; }));
  if (!shop || !api) throw new Error("Both private repository owners are required");
  api.setGitHub(state => { state.repo = "acme/api"; });
  const mapping = join(shop.dir, "portfolio.json");
  writeFixtureJson(mapping, { "acme/demo": { state: join(shop.dir, "github.json"), remote: shop.remote }, "acme/api": { state: join(api.dir, "github.json"), remote: api.remote } });
  const remotes = { "acme/demo": shop.remote, "acme/api": api.remote }, sourceRemotes: Record<string, string> = {};
  const common = { gh: [process.execPath, join(import.meta.dir, "..", "fake-portfolio-gh.ts"), mapping], remotes, sourceRemotes };
  return { shop, api, remotes, sourceRemotes, common };
}

/** Real private Git/GitHub boundaries; provider replies use the canonical in-process session port. */
export async function sharedWorld(name: string, worlds: World[]) {
  const { common, ...owners } = await products(name, worlds);
  const fakes = sharedAgents(join(owners.shop.dir, "scripted-replies"));
  const start = (options: Partial<EngineOptions> = {}) => {
    const engine = owners.shop.start({ ...common,
      agentCommand: () => undefined,
      toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" }, antigravity: { status: "ready" }, gh: { status: "ready" }, git: { status: "ready" }, node: { status: "ready" } }),
      startAgentSession: (launch, role) => { fakes.roles(engine.s.roles); return fakes.start(launch, role); }, ...options });
    fakes.roles(engine.s.roles);
    return engine;
  };
  return { ...owners, fakes, start };
}

/** Only transport/screen/reopen assertions opt into the real ACP process peer. */
export async function nativeSharedWorld(name: string, worlds: World[]) {
  const { common, ...owners } = await products(name, worlds);
  const fakes = new Fakes(join(owners.shop.dir, "agents"));
  fakes.scenario({ planner: "short", builder: "plain", reopen: "resume" });
  const start = (options: Partial<EngineOptions> = {}) => owners.shop.start({ ...common, ...options,
    agentCommand: () => [process.execPath, join(import.meta.dir, "..", "fake-agent.ts"), fakes.dir, `--script=${join(owners.shop.dir, "agents.json")}`] });
  return { ...owners, fakes, start };
}
