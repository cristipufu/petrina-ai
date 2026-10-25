/** Suite policy takes recorded observations; native execution and report parsing belong to adapters. */
export interface SuiteCounts { readonly tests: number; readonly passed: number; readonly failed: number; readonly skipped: number }
export interface SuiteExecution {
  readonly id: string;
  readonly workspaces: readonly string[];
  readonly requires?: readonly string[];
}
export interface WorkspaceEvidence {
  readonly workspace: string;
  readonly counts?: SuiteCounts;
  readonly failures?: readonly string[];
  readonly reportComplete?: boolean;
  readonly error?: string;
}
export interface ExecutionEvidence {
  readonly code: number;
  /** Actual elapsed time of this execution, recorded once even when it owns several workspaces. */
  readonly ms: number;
  readonly workspaces: readonly WorkspaceEvidence[];
  readonly error?: string;
}
export type SuiteResult = ({ readonly id: string } & ExecutionEvidence)
  | { readonly id: string; readonly workspaceNames: readonly string[]; readonly notRun: string };
export interface SuiteSource { readonly revision: string; readonly fingerprint: string }
export type ExecuteSuite = (execution: SuiteExecution, signal: AbortSignal) => Promise<ExecutionEvidence>;

const label = (id: string) => id.split("/").at(-1)!;
const sameMembers = (actual: readonly string[], expected: readonly string[]) => actual.length === expected.length
  && new Set(actual).size === actual.length && expected.every(name => actual.includes(name));
const validCounts = (value: SuiteCounts | undefined) => value !== undefined
  && [value.tests, value.passed, value.failed, value.skipped].every(count => Number.isSafeInteger(count) && count >= 0)
  && value.tests === value.passed + value.failed + value.skipped;
const reported = (result: WorkspaceEvidence) => result.reportComplete === true && validCounts(result.counts)
  && result.failures !== undefined
  && (result.counts!.passed > 0 || result.counts!.failed > 0 || result.failures.length > 0);

/** A report can be complete and still fail. Neither a zero process exit nor skipped-only work proves a pass. */
export function suitePassed(result: SuiteResult): boolean {
  return "code" in result && result.code === 0 && Number.isFinite(result.ms) && result.ms >= 0 && !result.error && result.workspaces.length > 0
    && result.workspaces.every(work => reported(work) && !work.error && !work.failures!.length && work.counts!.failed === 0);
}

/**
 * Own execution order, prerequisites, interruption and the final source binding without starting programs.
 * The caller owns each bounded execution and retains its actual reports and cleanup outcome.
 */
export class SuiteCoordinator {
  private readonly plan: readonly SuiteExecution[];
  private readonly source: SuiteSource;
  private readonly recorded: SuiteResult[] = [];
  private started = false;
  private finished = false;
  private interrupted = false;

  constructor(plan: readonly SuiteExecution[], source: SuiteSource) {
    if (!plan.length) throw new Error("The required suite plan is empty");
    if (!source.revision || !source.fingerprint) throw new Error("The required suite needs a starting source identity");
    const executions = new Set<string>(), workspaces = new Set<string>();
    this.plan = plan.map(entry => {
      if (!entry.id || executions.has(entry.id) || !entry.workspaces.length) throw new Error("A suite execution needs a unique identity and at least one workspace");
      for (const prerequisite of entry.requires ?? []) if (!executions.has(prerequisite)) throw new Error(`Suite ${entry.id} requires an earlier execution: ${prerequisite}`);
      for (const workspace of entry.workspaces) {
        if (!workspace || workspaces.has(workspace)) throw new Error(`A required workspace must belong to exactly one execution: ${workspace}`);
        workspaces.add(workspace);
      }
      executions.add(entry.id);
      return Object.freeze({ id: entry.id, workspaces: Object.freeze([...entry.workspaces]), ...(entry.requires ? { requires: Object.freeze([...entry.requires]) } : {}) });
    });
    this.source = { ...source };
  }

  get results(): readonly SuiteResult[] { return Object.freeze([...this.recorded]); }

  async run(execute: ExecuteSuite, signal: AbortSignal): Promise<void> {
    if (this.started) throw new Error("A suite coordinator can execute its plan only once");
    this.started = true;
    try {
      for (const entry of this.plan) {
        if (signal.aborted) break;
        if (entry.requires?.some(id => !suitePassed(this.recorded.find(result => result.id === id)!))) {
          this.recorded.push(Object.freeze({ id: entry.id, workspaceNames: entry.workspaces, notRun: `${entry.requires.map(label).join(" and ")} did not all pass` }));
          continue;
        }
        const observation = await execute(entry, signal);
        const workspaces = Object.freeze(observation.workspaces.map(work => Object.freeze({ ...work, ...(work.counts ? { counts: Object.freeze({ ...work.counts }) } : {}), ...(work.failures ? { failures: Object.freeze([...work.failures]) } : {}) })));
        const error = !sameMembers(workspaces.map(work => work.workspace), entry.workspaces) ? "Incomplete execution workspace manifest"
          : !Number.isSafeInteger(observation.code) || observation.code < 0 || !Number.isFinite(observation.ms) || observation.ms < 0 ? "Invalid execution outcome"
          : observation.error;
        this.recorded.push(Object.freeze({ id: entry.id, code: observation.code, ms: observation.ms, workspaces, ...(error ? { error } : {}) }));
      }
    } finally {
      this.interrupted = signal.aborted;
      for (const entry of this.plan) if (!this.recorded.some(result => result.id === entry.id)) {
        this.recorded.push(Object.freeze({ id: entry.id, workspaceNames: entry.workspaces, notRun: signal.aborted ? "the run was interrupted first" : "the runner stopped first" }));
      }
      this.finished = true;
    }
  }

  conclusion(ending: SuiteSource, interrupted = false): { complete: boolean; stableInputs: boolean; successful: boolean } {
    const stableInputs = ending.revision === this.source.revision && ending.fingerprint === this.source.fingerprint;
    const complete = this.finished && !interrupted && !this.interrupted && this.recorded.length === this.plan.length
      && this.recorded.every(result => "code" in result && sameMembers(result.workspaces.map(work => work.workspace), this.plan.find(entry => entry.id === result.id)!.workspaces) && result.workspaces.every(reported));
    return { complete, stableInputs, successful: stableInputs && complete && this.recorded.every(suitePassed) };
  }
}
