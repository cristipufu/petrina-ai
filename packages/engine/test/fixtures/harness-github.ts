import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLeasedProgramRecords } from "@petrina/test-support/leased-program-records";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { CLEANUP_MS } from "@petrina/test-support/commands";
import { waitFor } from "@petrina/test-support/fixtures";
import { childState, readProcessList, type ChildState } from "@petrina/platform/process-tree";
import { GH_ATTEMPT, GH_REGISTRATION_GATE, githubSettlement, type GitHubStart, type GitHubLink } from "./harness-github-state.js";

/** One case-owned lease, with native starter receipts independent of the actor's later handshake. */
export async function harnessGitHub(root: string) {
  const folder = join(root, "harness-github"), programs = await createLeasedProgramRecords(folder);
  const read = <T>(suffix: string): T[] => readdirSync(folder).filter(name => name.endsWith(suffix)).map(name => JSON.parse(readFileSync(join(folder, name), "utf8")) as T);
  let pending: { starts: string[]; actors: string[]; unregistered: string[]; states: [number, ChildState][] } | undefined;
  try {
  const program = programs.write("github.ts", "github", identity => `
try {
  const { writeFixtureJson } = await import(${JSON.stringify(import.meta.resolve("@petrina/test-support/fixture-json"))});
  const attempt = process.env[${JSON.stringify(GH_ATTEMPT)}];
  if (!attempt) throw new Error("GitHub fixture needs its native start identity");
  writeFixtureJson(${JSON.stringify(folder)} + "/" + ${identity}.id + ".link.json", { attempt, actor: ${identity}.id, pid: ${identity}.pid });
  const { runFakeGitHub } = await import(${JSON.stringify(import.meta.resolve("../fake-gh.ts"))});
  await runFakeGitHub(process.argv.slice(2));
} catch (error) {
  const { CommandFailure } = await import(${JSON.stringify(import.meta.resolve("@petrina/test-support/commands"))});
  const confirmed = error instanceof CommandFailure && (error.cleanup === "confirmed" ||
    error.cleanup === "none" && error.reason === "exit" && Number.isSafeInteger(error.code) && error.code >= 0);
  if (!confirmed) {
    const { writeFixtureJson } = await import(${JSON.stringify(import.meta.resolve("@petrina/test-support/fixture-json"))});
    writeFixtureJson(${JSON.stringify(folder)} + "/" + ${identity}.id + ".uncertain.json", { message: error instanceof Error ? error.message : String(error) });
  }
  process.stderr.write("fake gh could not answer: " + (error instanceof Error ? error.message : String(error)) + "\\n");
  process.exit(1);
}`, { beforeRecord: `
const fixtureArgs = process.argv.slice(2);
const fixtureRegistrationGate = fixtureArgs[2] === "pr" && fixtureArgs[3] === "list" ? process.env[${JSON.stringify(GH_REGISTRATION_GATE)}] : undefined;
if (fixtureRegistrationGate) {
  const fs = require("node:fs");
  fs.writeFileSync(fixtureRegistrationGate + ".reached", "");
  while (fs.existsSync(fixtureRegistrationGate)) await Bun.sleep(20);
}` });
  return { program, actors: programs.records, starts: () => read<GitHubStart>(".attempt.json"), pending: () => pending,
    stop: () => programs.close(),
    async settle() {
      await waitFor(async () => {
        const starts = read<GitHubStart>(".attempt.json"), actors = programs.records(), links = read<GitHubLink>(".link.json");
        const uncertain = new Set(actors.filter(actor => existsSync(join(folder, `${actor.id}.uncertain.json`))).map(actor => actor.id));
        const native = new Map<number, ChildState>();
        let snapshot: Promise<string | undefined> | undefined;
        const once = (ms: number) => snapshot ??= readProcessList(ms);
        for (const start of starts) if (Number.isSafeInteger(start.pid) && start.pid! > 0) native.set(start.pid!, await childState(start.pid!, 3_000, once));
        const settlement = githubSettlement(starts, actors, links, native, uncertain);
        if (settlement.kind === "uncertain") throw new Error(`${settlement.reason}; fixture root retained`);
        if (settlement.kind === "pending") pending = { starts: starts.map(start => start.id), actors: actors.map(actor => actor.id),
          unregistered: starts.filter(start => !links.some(link => link.attempt === start.id)).map(start => start.id), states: [...native] };
        return settlement.kind === "settled";
      }, "every native GitHub start and its registered helper to end", CLEANUP_MS);
      await programs.close();
    },
  };
  } catch (error) {
    try { await programs.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "GitHub fixture setup failed and its lease could not close"); }
    throw error;
  }
}

/** Installed only in the native harness process, before Engine construction, for its exact private GH command. */
export function observeHarnessGitHub(program: string, registrationGate?: string): void {
  const original = Bun.spawn;
  Bun.spawn = ((...given: unknown[]) => {
    const first = given[0], array = Array.isArray(first);
    const settings = (array ? given[1] : first) as Record<string, unknown> | undefined;
    const argv = array ? first : settings?.cmd;
    if (!Array.isArray(argv) || argv[0] !== process.execPath || argv[1] !== program) return Reflect.apply(original, Bun, given);
    const id = crypto.randomUUID(), folder = dirname(program), file = join(folder, `${id}.attempt.json`);
    const publish = (record: GitHubStart) => writeFixtureJson(file, record);
    publish({ id, state: "entered" });
    const env = { ...((settings?.env as NodeJS.ProcessEnv | undefined) ?? process.env), [GH_ATTEMPT]: id,
      ...(registrationGate ? { [GH_REGISTRATION_GATE]: registrationGate } : {}) };
    let child: ReturnType<typeof Bun.spawn>;
    try {
      const spawnSettings = {
        ...settings,
        env,
        ...(process.platform === "win32" ? { detached: true, windowsHide: true } : {}),
      };
      const forwarded = [...given];
      if (array) forwarded[1] = spawnSettings;
      else forwarded[0] = spawnSettings;
      child = Reflect.apply(original, Bun, forwarded);
    } catch (error) { publish({ id, state: "start-unknown" }); throw error; }
    // The exact returned handle is observed before recording/returning it can fail.
    void child.exited.then(code => publish({ id, state: "exited", pid: child.pid, code }),
      () => publish({ id, state: "exit-unknown", pid: child.pid })).catch(error => {
        process.stderr.write(`Fixture GitHub exit observation could not be recorded: ${String(error)}\n`);
        process.exit(1);
      });
    publish({ id, state: "started", pid: child.pid });
    return child;
  }) as typeof Bun.spawn;
}
