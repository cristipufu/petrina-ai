import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { quoteGitShellWord } from "@petrina/test-support/git-program";
import { createProcessLease } from "@petrina/test-support/process-lease";
import { runCommand } from "@petrina/test-support/commands";
import { completedCommandRecord } from "@petrina/test-support/completed-command-record";
import { FALLBACK_TIMEOUT } from "@petrina/test-support/run";
import { directDrivers } from "./direct-drivers.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { commitAt, FAKE_GH, finish, git, gitWith, remoteRef, taskOf, testGitEnv } from "../support.js";
import { ScriptedAgents } from "../scripted-agents.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import { sharedAgents } from "./shared-agents.js";

interface PrivateWorld { dir: string; clone: string; remote: string; data: string }
interface CommonCase { mode: "pull-request" | "release"; world: PrivateWorld; evil: string }
export type SecurityDeliveryCase = CommonCase & (
  | { kind: "redirect"; hooks: string; globalConfig: string; libOrigin: string; unpushed: string }
  | { kind: "ssh"; ssh: string }
);
export interface SecurityDeliveryProbe {
  kind: SecurityDeliveryCase["kind"];
  task: { error?: string; state: string; branch?: string };
  tested?: string;
  deliveredRef?: string;
  evilRefs?: string;
  savedAddress?: string;
  registeredAddress?: string;
  plantedTag?: string;
  tags?: string;
  gitlink?: string;
  libraryBefore?: boolean;
}

/** A real credentialed Engine/Git scenario in one isolated process environment. No assertions or runner nesting. */
export async function credentialedDeliveryChild(input: SecurityDeliveryCase): Promise<SecurityDeliveryProbe> {
  const { world, mode } = input;
  const ownerRoot = join(world.dir, "credentialed-child-owner");
  mkdirSync(ownerRoot);
  const owners = directDrivers(ownerRoot);
  const result = await setupWithCleanup(() => owners.prepare(async () => {
  const replies = sharedAgents(join(world.dir, "provider-replies"));
  replies.scenario({ planner: "short", builder: "plain" });
  const agents = new ScriptedAgents(async (prompt, signal, callbacks) => {
    if (input.kind === "redirect" && prompt.result === "build") {
      await git(prompt.cwd, "update-index", "--add", "--cacheinfo", `160000,${input.unpushed},lib`);
    }
    return replies.respond(prompt, signal, callbacks);
  });
  const engine = owners.open(world.data, {
    startAgentSession: agents.start,
    toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" }, antigravity: { status: "ready" }, gh: { status: "ready" }, git: { status: "ready" } }),
    gh: [process.execPath, FAKE_GH, join(world.dir, "github.json"), world.remote],
    ...(input.kind === "redirect" ? { remote: world.remote } : {}),
    awakeObserver: () => {},
  });
  return owners.run(engine, async () => {
    const productId = await engine.addProduct(world.clone);
    engine.setProductDelivery(productId, mode, false);
    const registeredAddress = engine.getState().products[0]!.remote;
    await git(world.clone, "remote", "set-url", "origin", input.evil);
    await git(world.clone, "remote", "set-url", "--push", "origin", input.evil);
    if (input.kind === "redirect") await git(world.clone, "config", "core.hooksPath", input.hooks);
    const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
    const task = taskOf(await finish(engine, taskId), taskId);
    const facts = { error: task.error, state: task.state, branch: task.branch };
    if (task.error || task.state !== (mode === "pull-request" ? "pr-open" : "done")) return { kind: input.kind, task: facts, registeredAddress };
    const tested = await git(world.clone, "rev-parse", task.branch!);
    const result: SecurityDeliveryProbe = {
      kind: input.kind,
      task: facts,
      tested,
      deliveredRef: await remoteRef(world.remote, mode === "pull-request" ? `refs/heads/${task.branch}` : input.kind === "ssh" ? "refs/tags/v0.1.0" : "refs/heads/main"),
      evilRefs: await git(world.dir, "--git-dir", input.evil, "for-each-ref"),
      savedAddress: engine.getState().products[0]!.remote,
      registeredAddress,
    };
    if (input.kind === "redirect") {
      result.plantedTag = await remoteRef(world.remote, "refs/tags/planted");
      result.tags = await git(world.dir, "--git-dir", world.remote, "for-each-ref", "--format=%(refname)", "refs/tags");
      result.gitlink = await git(world.dir, "--git-dir", world.remote, "rev-parse", `${tested}:lib`);
      result.libraryBefore = (await commitAt(input.libOrigin, input.unpushed)) !== undefined;
    }
    return result;
  });
  }), () => owners.close());
  await owners.close();
  return result;
}

/** The plain-push positive control runs only after the parent accepted the native delivery observations. */
export async function plainGitControlChild(input: Extract<SecurityDeliveryCase, { kind: "redirect" }> & { tested: string }): Promise<boolean> {
  const plain = testGitEnv(process.env), { world } = input;
  await gitWith({ cwd: world.clone, env: { ...plain, GIT_CONFIG_GLOBAL: input.globalConfig } }, "-c", "core.hooksPath=/dev/null", "push", "-q", "--no-verify", world.remote, `${input.tested}:refs/heads/plain`);
  return (await commitAt(input.libOrigin, input.unpushed)) !== undefined;
}

/** The parent retains its own environment; only the owned child's environment receives these settings. */
async function ownedSecurityObservation<T>(input: SecurityDeliveryCase & { tested?: string }, entry: "credentialedDeliveryChild" | "plainGitControlChild"): Promise<T> {
  const lease = await createProcessLease();
  try {
    const program = join(input.world.dir, "credentialed-delivery.ts");
    writeFileSync(program, lease.program(`
    const owner = await import(${JSON.stringify(pathToFileURL(import.meta.path).href)});
    const input = JSON.parse(await new Response(Bun.stdin).text());
    const result = await owner[${JSON.stringify(entry)}](input);
    console.log("PETRINA_SECURITY_RESULT " + JSON.stringify({ entry: ${JSON.stringify(entry)}, result }));
    `));
    const result = await runCommand([process.execPath, "--no-env-file", program], {
      cwd: input.world.dir, input: JSON.stringify(input), timeoutMs: FALLBACK_TIMEOUT,
      env: { ...process.env, ...(input.kind === "redirect" ? { GIT_CONFIG_GLOBAL: input.globalConfig } : { GIT_SSH_COMMAND: quoteGitShellWord(input.ssh) }) },
    });
    const observed = completedCommandRecord(result, "PETRINA_SECURITY_RESULT ") as { entry: string; result: T };
    if (observed.entry !== entry) throw new Error("The owned credentialed Git scenario returned another operation's result");
    return observed.result;
  } finally { await lease.close(); }
}

export async function credentialedDelivery(input: SecurityDeliveryCase): Promise<SecurityDeliveryProbe> {
  const result = await ownedSecurityObservation<SecurityDeliveryProbe>(input, "credentialedDeliveryChild");
  if (result.kind !== input.kind) throw new Error("The owned credentialed Git scenario returned another case's result");
  return result;
}

export function plainGitControl(input: Extract<SecurityDeliveryCase, { kind: "redirect" }> & { tested: string }): Promise<boolean> {
  return ownedSecurityObservation(input, "plainGitControlChild");
}
