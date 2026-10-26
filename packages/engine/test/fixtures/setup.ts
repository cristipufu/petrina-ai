import { afterAll } from "bun:test";
import { join } from "node:path";
import { checkOf, type AgentProfile, type CheckId, type State, type Task } from "@petrina/core";
import { Engine, type EngineOptions } from "../engine.js";
import { findProgram } from "@petrina/agent-runtime/tools";
import { FAKE_GH } from "../support.js";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";
import { nativeWorldFixtures, type NativeWorld } from "./native-worlds.js";
import { clone, makeGitHubClone } from "../../../repositories/test/fixtures/discovery.js";

export function setupFixtures() {
  const fake = join(import.meta.dir, "../fake-agent.ts");
  const fakeGh = join(import.meta.dir, "../fake-gh.ts");
  const temp = tempDir("petrina-setup-");
  /** The worlds with a stand-in GitHub, each in a folder of its own. */
  const worlds = nativeWorldFixtures();
  afterAll(async () => {
    await worlds.close();
    removeDir(temp);
  });

  let made = 0;
  const fresh = (name: string) => join(temp, `${name}-${(made += 1)}`);

  /**
   * Fake agents per tool: "ok", logged out (refusing conversations), not logged in (opening conversations
   * and asking for a login only at the first message, as Claude Code does), one that never says whether
   * it is logged in, one that exits as it starts, one that never opens a conversation, or one that never
   * opens one and ignores being told to stop.
   */
  type Behaviour = "ok" | "logged-out" | "not-logged-in" | "silent-login" | "wont-start" | "hang" | "stubborn" | "silent-stubborn";
  const agents = (tools: Partial<Record<CheckId, Behaviour>>, dir?: string): EngineOptions["agentCommand"] => (profile: AgentProfile) => {
    const behaviour = tools[profile.toolId as CheckId] ?? (["grok", "antigravity"].includes(profile.toolId) ? "logged-out" : "ok");
    const flags = behaviour === "ok" ? [] : behaviour === "stubborn" ? ["--hang", "--stubborn"] : behaviour === "silent-stubborn" ? ["--silent-login", "--stubborn"] : [`--${behaviour}`];
    // Like the real Grok, which sends no login report: it signs in as a conversation opens, and refuses it logged out.
    if (profile.toolId === "grok" && !flags.includes("--silent-login")) flags.push("--silent-login");
    return [process.execPath, fake, ...(dir ? [dir] : []), ...flags];
  };

  /** Wait for a condition, answering the inbox like a coordinator who approves everything. */
  async function until(engine: Engine, done: (state: State) => boolean, ms = 60_000): Promise<State> {
    const started = Date.now();
    const seen = new Set<string>();
    for (;;) {
      const state = engine.getState();
      if (done(state)) return state;
      if (Date.now() - started > ms * SLOW) throw new Error(`Timed out. Tasks: ${JSON.stringify(state.tasks.map((task) => [task.state, task.statusLine, task.error]))}`);
      for (const item of state.inbox) {
        if (seen.has(item.id) || item.kind === "stuck") continue;
        seen.add(item.id);
        if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
        else if (item.kind === "permission") engine.allow(item.id, "once");
        else engine.approve(item.id);
      }
      await Bun.sleep(50);
    }
  }

  /**
   * A check's time limit where the test is not about the limit itself. It only catches a hang, and an answer
   * comes as soon as a stand-in gives it, so it is generous: other test runs on the same machine can make a
   * stand-in take seconds just to start.
   */
  const LIMIT = 30_000 * SLOW;
  /** This machine's programs without the GitHub CLI, whose real check can take long to answer without a network. */
  const noGh = (name: string) => (name === "gh" ? null : findProgram(name));

  /** Sentences in a text: ends of sentences, ignoring dots inside names like notes.txt. */
  const sentences = (text: string) => text.split(/[.!?](?:\s|$)/).filter((part) => part.trim()).length;
  /** Why a promise was refused. */
  const refusal = (promise: Promise<unknown>) => promise.then(() => "", (error: Error) => error.message);

  const status = (engine: Engine, id: CheckId) => checkOf(engine.getState().setup?.checks, id).status;
  const taskOf = (state: State, id: string) => state.tasks.find((task) => task.id === id)!;
  /** Every tool a task's plan and timeline used. */
  const toolsUsed = (engine: Engine, task: Task) => {
    const toolOf = (profileId: string | undefined) => engine.getState().profiles.find((profile) => profile.id === profileId)?.toolId;
    const planned = (task.plan?.stages ?? []).flatMap((stage) => [...stage.profileIds, ...(stage.reviewerProfileIds ?? [])]);
    const worked = task.timeline.map((entry) => entry.profileId).filter(Boolean);
    return new Set([...planned, ...worked, task.plan?.plannerProfileId].map(toolOf).filter(Boolean));
  };


  const run = async <T>(tools: Partial<Record<CheckId, Behaviour>>, body: (run: { engine: Engine; taskId: string; w: NativeWorld }) => Promise<T>, options: EngineOptions = {}): Promise<T> =>
    worlds.world("tools", async fixture => {
      const w = fixture.world;
      return fixture.engine(async engine => {
        await engine.checkTools();
        const productId = await engine.addProduct(w.clone);
        engine.setProductDelivery(productId, "release", false);
        const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file." });
        return body({ engine, taskId, w });
      }, { agentCommand: agents(tools), gh: [process.execPath, FAKE_GH, join(w.dir, "github.json"), w.remote], remote: w.remote, toolCheckTimeoutMs: LIMIT, ...options }, { defaults: "none" });
    }, { version: "1.0.0" });

  return { fakeGh, temp, worlds, fresh, agents, until, status, taskOf, toolsUsed, LIMIT, noGh, sentences, refusal, run, clone, makeGitHubClone };
}
