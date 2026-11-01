import { join } from "node:path";
import { completeAll } from "@petrina/core";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import type { Engine, EngineOptions } from "../engine.js";
import { Fakes, makeWorld, tempDir, type World } from "../support.js";
import { closeDirectDrivers, directDrivers } from "./direct-drivers.js";
import { sourcePrepared } from "./source-prepared.js";
import { sharedChecksPrepared } from "./shared-checks-prepared.js";
import { sharedAgents } from "./shared-agents.js";
import { scriptedGitHub } from "../scripted-github.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import { acmeDemoProduct, installPreparedProduct } from "./prepared-product.js";
import { installSharedSourceCandidates } from "./shared-source-candidate.js";
import { installSharedWorkflowFastPaths } from "./shared-preparation.js";
import { fakeEngineSettings } from "./fake-agent-sessions.js";

type SharedWorld = Omit<World, "start"> & {
  /** Explicit known fixture metadata; the workflow still performs every native source/check/delivery operation. */
  preparedProduct(engine: Engine): string;
};
type SharedOptions = Partial<EngineOptions>;
interface SharedProducts {
  shop: SharedWorld;
  api: SharedWorld;
  remotes: Record<string, string>;
  sourceRemotes: Record<string, string>;
}
export interface SharedFixture extends SharedProducts {
  fakes: ReturnType<typeof sharedAgents>;
  planned(engine: Engine, input: Parameters<Engine["addTask"]>[0]): Promise<string>;
  sourceCandidate(engine: Engine, input: Parameters<Engine["addTask"]>[0], options?: { checks: "none" }): Promise<string>;
  builtChecks(engine: Engine, input: Parameters<Engine["addTask"]>[0]): Promise<string>;
  engine<T>(body: (engine: Engine) => Promise<T>, options?: SharedOptions): Promise<T>;
}
export interface NativeSharedFixture extends SharedProducts {
  fakes: Fakes;
  engine<T>(body: (engine: Engine) => Promise<T>, options?: SharedOptions): Promise<T>;
}
type Entry = { root: string; lifetime: ReturnType<typeof directDrivers>; closed: boolean };
const closed = () => new Error("Shared fixture ownership is closing; no new world, Engine or callback may start");

/** Required world/generation callbacks keep setup and manual native work inside their actual owner. */
export function sharedWorldFixtures() {
  const active = new Set<Entry>();
  let accepting = true, closing: Promise<void> | undefined;
  const available = (entry: Entry) => { if (!accepting || entry.closed) throw closed(); };
  const observeClose = (entry: Entry, work: Promise<void>) => {
    void work.then(() => { active.delete(entry); }, () => undefined);
    return work;
  };
  const closeEntry = (entry: Entry): Promise<void> => {
    entry.closed = true;
    return observeClose(entry, entry.lifetime.close());
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    let done!: () => void, failed!: (error: unknown) => void;
    closing = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
    accepting = false;
    const entries = [...active];
    // All admission gates close before any native stop can reenter another world.
    for (const entry of entries) entry.closed = true;
    const joined = closeDirectDrivers(entries.map(entry => entry.lifetime));
    for (const entry of entries) observeClose(entry, entry.lifetime.close());
    void joined.then(done, failed);
    return closing;
  };

  async function products(name: string, entry: Entry) {
    const { lifetime, root } = entry;
    const [shop, api] = await completeAll([
      { name: `shared-shop-${name}`, folder: "shop" },
      { name: `shared-api-${name}`, folder: "api", address: "https://github.com/acme/api.git" },
    ].map(recipe => Promise.resolve().then(() => {
      available(entry);
      return makeWorld(recipe.name, { address: recipe.address,
        owner: { root: join(root, recipe.folder), open: (data, options) => lifetime.open(data, options) },
      });
    })));
    available(entry);
    if (!shop || !api) throw new Error("Both private repository owners are required");
    api.setGitHub(state => { state.repo = "acme/api"; });
    const mapping = join(shop.dir, "portfolio.json");
    writeFixtureJson(mapping, { "acme/demo": { state: join(shop.dir, "github.json"), remote: shop.remote }, "acme/api": { state: join(api.dir, "github.json"), remote: api.remote } });
    const remotes = { "acme/demo": shop.remote, "acme/api": api.remote }, sourceRemotes: Record<string, string> = {};
    const common = { gh: [process.execPath, join(import.meta.dir, "..", "fake-portfolio-gh.ts"), mapping], remotes, sourceRemotes };
    return { shop, api, remotes, sourceRemotes, common };
  }

  type Prepared = Awaited<ReturnType<typeof products>>;
  const visible = ({ shop: rawShop, api: rawApi, remotes, sourceRemotes }: Prepared): SharedProducts => {
    const { start: _shopStart, ...shop } = rawShop, { start: _apiStart, ...api } = rawApi;
    return {
      shop: { ...shop, preparedProduct: (engine: Engine) => installPreparedProduct(engine, acmeDemoProduct(shop.clone)) },
      api: { ...api, preparedProduct: (engine: Engine) => installPreparedProduct(engine, {
        id: "api", name: "API", repo: "acme/api", tone: "green", path: api.clone,
        remote: "https://github.com/acme/api.git", defaultBranch: "main", delivery: "pull-request", approveDelivery: true,
      }) },
      remotes, sourceRemotes,
    };
  };
  const generation = (entry: Entry, start: (options: SharedOptions) => Engine): SharedFixture["engine"] =>
    async <T>(body: (engine: Engine) => Promise<T>, options: SharedOptions = {}): Promise<T> => {
      available(entry);
      const current = start(options);
      const result = await setupWithCleanup(() => entry.lifetime.run(current, () => body(current)), () => entry.lifetime.stop(current));
      await entry.lifetime.stop(current);
      return result;
    };
  const scripted = (prepared: Prepared, entry: Entry): SharedFixture => {
    const { shop, common } = prepared;
    const fakes = sharedAgents(join(shop.dir, "scripted-replies"));
    const candidates = new Map<string, "version" | "none">();
    const start = (options: SharedOptions) => {
      const customCheck = options.runCheckCommand;
      const engine = shop.start({ ...common,
        github: scriptedGitHub({ "acme/demo": { state: join(prepared.shop.dir, "github.json"), remote: prepared.shop.remote }, "acme/api": { state: join(prepared.api.dir, "github.json"), remote: prepared.api.remote } }),
        agentCommand: () => undefined,
        toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" }, antigravity: { status: "ready" }, gh: { status: "ready" }, git: { status: "ready" } }),
        startAgentSession: (launch, role) => { fakes.roles(engine.s.roles); return fakes.start(launch, role); },
        ...options,
        runCheckCommand: async (req) => {
          const handled = await customCheck?.(req);
          if (handled !== undefined) return handled;
          if (req.argv.length === 2 && req.argv[0] === "git" && req.argv[1] === "--version") {
            return { code: 0, stdout: "git version 2.45.0\n" };
          }
          return undefined;
        },
      });
      fakes.roles(engine.s.roles);
      installSharedSourceCandidates(engine, candidates, () => available(entry));
      installSharedWorkflowFastPaths(engine, { skipUpToDate: true, fastCheckCapture: true });
      return engine;
    };
    const planned: SharedFixture["planned"] = (engine, input) => entry.lifetime.run(engine,
      () => sourcePrepared(engine, input, fakes.plan(), { kind: "plan" }, () => available(entry)));
    const builtChecks: SharedFixture["builtChecks"] = (engine, input) => entry.lifetime.run(engine,
      () => sharedChecksPrepared(engine, input, fakes.plan(), () => available(entry)));
    const sourceCandidate: SharedFixture["sourceCandidate"] = (engine, input, options) => entry.lifetime.run(engine, async () => {
      const id = await planned(engine, input);
      available(entry); engine.stopRequested.signal.throwIfAborted();
      const task = engine.task(id)!;
      if (task.stageIndex !== -1 || !task.confirmWork || task.repositories?.some(work => work.worktree))
        throw new Error("The source candidate must still be awaiting real shared plan approval");
      candidates.set(id, options?.checks ?? "version");
      return id;
    });
    return { ...visible(prepared), fakes, engine: generation(entry, start), planned, builtChecks, sourceCandidate };
  };
  const native = (prepared: Prepared, entry: Entry): NativeSharedFixture => {
    const { shop, common } = prepared;
    const fakes = new Fakes(join(shop.dir, "agents"));
    fakes.scenario({ planner: "short", builder: "plain", reopen: "resume" });
    const start = (options: SharedOptions) => {
      const engine = shop.start({
        ...common,
        github: scriptedGitHub({ "acme/demo": { state: join(prepared.shop.dir, "github.json"), remote: prepared.shop.remote }, "acme/api": { state: join(prepared.api.dir, "github.json"), remote: prepared.api.remote } }),
        ...fakeEngineSettings(fakes, { scriptPath: join(shop.dir, "agents.json") }),
        usageCommands: { codex: null, grok: null, antigravity: null },
        ...options,
      });
      installSharedWorkflowFastPaths(engine);
      return engine;
    };
    return { ...visible(prepared), fakes, engine: generation(entry, start) };
  };
  async function use<T, Fixture>(name: string, body: (fixture: Fixture) => Promise<T>, prepare: (products: Prepared, entry: Entry) => Fixture): Promise<T> {
    if (!accepting) throw closed();
    if (typeof body !== "function") throw new TypeError("Shared fixtures require an owned whole-body callback");
    const root = tempDir(`petrina-shared-${name}-`), lifetime = directDrivers(root);
    const entry: Entry = { root, lifetime, closed: false };
    active.add(entry);
    const result = await setupWithCleanup(() => lifetime.prepare(async () => {
      const prepared = await products(name, entry);
      available(entry);
      const fixture = prepare(prepared, entry);
      available(entry);
      return body(fixture);
    }), () => closeEntry(entry));
    await closeEntry(entry);
    return result;
  }
  return {
    world: <T>(name: string, body: (fixture: SharedFixture) => Promise<T>) => use(name, body, scripted),
    nativeWorld: <T>(name: string, body: (fixture: NativeSharedFixture) => Promise<T>) => use(name, body, native),
    close,
  };
}
