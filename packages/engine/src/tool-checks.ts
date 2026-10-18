// The tools check: is each tool installed and logged in. First run, the Library, the planner and Stuck
// items all read the answers from the state. Each check runs on its own, so a slow one never holds up
// the others; a second ask joins the one under way; and a tool a check gave up on is gone before the
// next check starts it again, so copies never pile up.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CHECK_NAMES, checkOf, type AgentProfile, type CheckId, type Id, type ToolCheck } from "@petrina/core";
import { agentEnv } from "./env.js";
import { Kernel, notReady, ToolProblem, type MTask } from "./kernel.js";
import { checkAgentTool, checkGh, checkGit, checkNode, isAuthRequired, type CheckResult, type Which } from "./setup.js";
import { ADAPTERS, findProgram } from "./tools.js";

/** Everything the tools check looks at, in the order it is shown. */
export const CHECKS: readonly CheckId[] = ["claude-code", "codex", "grok", "gh", "git", "node"];
/** How long a check waits for the last check's copy of a tool to stop: past the forced stop, never longer. */
const LINGER_MS = 3_000;

export class ToolChecks {
  /** Tool checks under way, so a second ask joins the first. */
  private readonly checking = new Map<CheckId, Promise<void>>();
  /** An agent tool a check gave up on, until its process is gone: the next check waits for it, so copies never pile up. */
  private readonly lingering = new Map<CheckId, Promise<void>>();
  private readonly stopping = new AbortController();

  constructor(private readonly k: Kernel) {}

  /** Quitting stops tool-check agents too, and waits for their remaining programs before exiting. */
  async shutdown(): Promise<void> {
    this.stopping.abort();
    await Promise.allSettled([...this.checking].filter(([id]) => ADAPTERS[id] !== undefined).map(([, job]) => job));
    await Promise.allSettled([...this.lingering.values()]);
  }

  /** Check every tool again, each on its own, so a slow one never holds up the others. */
  async checkAll(): Promise<void> {
    await Promise.all(CHECKS.map((id) => this.check(id)));
  }

  check(id: CheckId): Promise<void> {
    if (this.stopping.signal.aborted || this.k.stopped) return Promise.resolve();
    const running = this.checking.get(id);
    if (running) return running;
    // A program that isn't on this machine is Not installed at once, never "Checking" first: a row for a
    // tool that isn't there (Grok, say) never shows up only to go away again.
    if (this.absent(id)) {
      this.put(id, { id, status: "not-installed", at: Date.now() });
      this.k.commit();
      return Promise.resolve();
    }
    this.put(id, { ...checkOf(this.k.s.setup?.checks, id), checking: true });
    this.k.commit();
    // A copy from the last check that is still stopping is gone first (a few seconds at most).
    const before = this.lingering.get(id);
    const job = (before ? Promise.race([before, Bun.sleep(LINGER_MS)]) : Promise.resolve())
      .then((): CheckResult | Promise<CheckResult> => this.lingering.has(id)
        ? { status: "unknown", detail: `${CHECK_NAMES[id]} is still stopping after its last check, so try Check again in a moment.` }
        : this.run(id))
      .catch((error): CheckResult => ({ status: "unknown", detail: error instanceof Error ? error.message : String(error) }))
      .then((result) => {
        this.put(id, { id, ...result, at: Date.now() });
        this.k.commit();
      })
      .finally(() => this.checking.delete(id));
    this.checking.set(id, job);
    return job;
  }

  status(id: CheckId) {
    return checkOf(this.k.s.setup?.checks, id).status;
  }

  /** A tool would not start: why, in a form the coordinator can act on. */
  async problem(toolId: Id, error: unknown): Promise<ToolProblem> {
    const id = toolId as CheckId;
    const detail = error instanceof Error ? error.message : String(error);
    if (isAuthRequired(error)) {
      this.put(id, { id, status: "logged-out", at: Date.now() });
      this.k.commit();
      return new ToolProblem(id, "logged-out", detail);
    }
    await this.check(id);
    const status = this.status(id);
    return new ToolProblem(id, notReady(status) ? status : "wont-start", detail);
  }

  /** Before a delivery to GitHub: the GitHub CLI must be logged in, or nothing ships. Couldn't check: it goes ahead. */
  async needGitHub(task: MTask): Promise<void> {
    const before = task.statusLine;
    task.statusLine = "Checking the GitHub login";
    this.k.commit();
    await this.check("gh");
    const status = this.status("gh");
    if (notReady(status)) throw new ToolProblem("gh", status);
    // Checked: the card no longer says so while the delivery's next steps run.
    if (task.statusLine === "Checking the GitHub login") {
      task.statusLine = before;
      this.k.commit();
    }
  }

  /** Retry on a Stuck item about a tool: true while the tool is still not installed or not logged in. */
  async stillNotReady(toolId: CheckId, task: MTask | undefined): Promise<boolean> {
    await this.check(toolId);
    const status = this.status(toolId);
    if (!notReady(status)) return false;
    if (task) {
      this.k.log(task, "warn", `Checked ${CHECK_NAMES[toolId]} again: it is still ${status === "logged-out" ? "not logged in" : "not installed"}`);
      this.k.commit();
    }
    return true;
  }

  /** The program behind a check is not on the PATH (tests that stand in a program never count as absent). */
  private absent(id: CheckId): boolean {
    const which = this.which();
    if (id === "git" || id === "node") return which(id) === null;
    if (id === "gh") return !this.k.options.gh && which("gh") === null;
    return !this.k.options.agentCommand && which(ADAPTERS[id]!.cli) === null;
  }

  /** The Library's own lookup, so first run finds what Terminal finds, also when opened from the Dock. */
  private which(): Which {
    return this.k.options.which ?? findProgram;
  }

  private run(id: CheckId): Promise<CheckResult> {
    const which = this.which();
    const timeoutMs = this.k.options.toolCheckTimeoutMs;
    const platform = this.k.s.setup?.platform ?? "linux";
    if (id === "git") return checkGit(which, platform, { ...(timeoutMs ? { timeoutMs } : {}), ...(this.k.options.developerTools ? { developerTools: this.k.options.developerTools } : {}) });
    if (id === "node") return checkNode(which, timeoutMs);
    if (id === "gh") {
      const gh = this.k.options.gh ?? [which("gh")].filter((path): path is string => path !== null);
      return gh.length ? checkGh(gh, timeoutMs) : Promise.resolve({ status: "not-installed" });
    }
    const profile = this.k.s.profiles.find((entry) => entry.toolId === id) as AgentProfile;
    const command = this.k.options.agentCommand?.(profile);
    return (async () => {
      // An empty folder of Petrina's own: never a product's, so no product's settings are read.
      const cwd = join(this.k.dataDir, "checks");
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      const onGone = (gone: Promise<void>) => {
        this.lingering.set(id, gone);
        void gone.then(() => {
          if (this.lingering.get(id) === gone) this.lingering.delete(id);
        });
      };
      // The environment agents run in, so the answer is about the setup they really get.
      return checkAgentTool({ adapter: ADAPTERS[id]!, profile, ...(command ? { command } : {}), env: agentEnv(process.env), cwd, which, onGone, signal: this.stopping.signal, ...(timeoutMs ? { timeoutMs } : {}) });
    })();
  }

  private put(id: CheckId, check: ToolCheck): void {
    const setup = this.k.s.setup;
    if (!setup) return;
    const next = { ...check, id };
    if (!next.checking) delete next.checking;
    setup.checks = [...setup.checks.filter((entry) => entry.id !== id), next].sort((a, b) => CHECKS.indexOf(a.id) - CHECKS.indexOf(b.id));
    // The Library, the planner and the review's voters read the agent tools' status here too.
    const tool = this.k.s.tools.find((entry) => entry.id === id);
    if (tool && (next.status === "ready" || notReady(next.status))) tool.status = next.status;
  }
}
