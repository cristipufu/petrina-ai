vi.mock("../../../src/notify/channels", () => {
  const unexpected = () => { throw new Error("This presentation test did not request a native notification."); };
  return { platform: () => "linux", browserPermission: () => "unsupported", useBrowserPermission: () => "unsupported", askBrowser: async () => "unsupported",
    BrowserNotices: class { show = unexpected; test = unexpected; waiting() {} },
    shell: { show: unexpected, test: unexpected, badge: unexpected, onClick: unexpected, onRelaunch: unexpected } };
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: () => { throw new Error("This presentation test did not request a native desktop operation."); } }));

import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordedCheckBatch, builderCheckSummary, gateTitle, gateStatus, deliveryLabel, beginAgentStep, endAgentStep, beginYouStep, decisionEvidence, recordStepResult, recordCheckReuse, Simulator, createDemoState, type State, type Task, type DeepMutable } from "@petrina/core";
import { App } from '../../../src/App';
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { acceptanceFixture } from "../../fixtures/acceptance";
import { setupObservation } from "../../fixtures/check-setup";

let simulator: Simulator;

const live = { link: 'live', desktop: false };

const empty: never[] = [];

vi.mock('../../../src/engine', () => ({
  mode: 'demo', desktop: false,
  startClock: () => () => {},
  useEngineStatus: () => live,
  useUnsent: () => empty,
  useSim: () => useSyncExternalStore((fn) => simulator.subscribe(fn), () => simulator.getState()),
  sim: new Proxy({}, { get: (_, name) => name === 'synced' ? () => true : (...args: unknown[]) => (simulator[name as keyof Simulator] as Function).apply(simulator, args) }),
}));

const NOW = 1_000_000_000_000;

// Explicit completed scenario input; missing/running/stopped controls deliberately omit this.
const completedRun = (name: string, code: number, output = "") => ({ name, command: `check ${name}`, ms: 100, ok: code === 0, output, execution: completeCheckExecution(code) });

let root: Root;

let host: HTMLDivElement;

const taskOf = (state: State, id: string): Task => state.tasks.find((task) => task.id === id)!;

async function render(node: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(node)); }

beforeEach(() => localStorage.clear());

afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });

describe('the journey in the task sheet', () => {
  async function mount(state: State) {
    simulator = new Simulator({ ...state, pool: { ...state.pool, paused: true } });
    await render(<App />);
  }

  async function openTask(id: string) {
    await act(async () => host.querySelector<HTMLElement>(`.card-open[aria-describedby~="status-${id}"]`)!.click());
  }

  it.each(['running', 'stopped', 'interrupted', 'reused', 'missing'])('keeps %s command evidence separate from acceptance', async (variant) => {
    const { state, task } = acceptanceFixture();
    const step = task.journey![2]!;
    task.journey = task.journey!.slice(0, 3);
    if (variant === 'running') { delete step.endedAt; delete step.end; step.productChecks = [{ name: 'Tests', result: 'running' }]; }
    if (variant === 'stopped' || variant === 'interrupted') step.productChecks = [{ name: 'Tests', result: 'stopped', detail: 'Original interrupted diagnostic' }];
    if (variant === 'interrupted') step.productChecks = [{ name: 'Tests', result: 'fail', detail: 'Original interrupted diagnostic', run: { name: 'Tests', command: 'test', ms: 100, ok: false, output: 'Original interrupted diagnostic', interruption: { source: 'macOS power log', at: state.now - 550, event: 'Recorded sleep event' } } }];
    if (variant === 'reused') { step.work = 'check-reuse'; step.productChecks = step.productChecks!.map((check) => ({ ...check, reusedAt: state.now, source: { stepId: 'original-command-run', attemptId: 'run-0', checkId: 'tests' } })); }
    if (variant === 'missing') { delete step.productChecks; task.checks = { at: state.now, results: [{ name: 'Unattributed later command', command: 'test', ms: 1, ok: true, output: 'Passed' }] }; }
    await mount(state); await openTask(task.id);
    await act(async () => host.querySelector<HTMLElement>('.journey-list li[data-step-id="j65"]')!.click());
    const details = host.querySelector('.journey-details')!;
    expect(details.textContent).not.toContain('Acceptance requirement');
    if (variant === 'running') expect(details.textContent).toContain('Running');
    if (variant === 'stopped' || variant === 'interrupted') expect(details.textContent).toContain('Original interrupted diagnostic');
    if (variant === 'reused') {
      expect(details.textContent).toContain('no new execution');
      expect(details.textContent).toContain('Second recorded timeout diagnostic');
      expect(details.querySelector('a[href*="node=original-command-run"]')).toBeTruthy();
    }
    if (variant === 'missing') { expect(details.textContent).toContain('Automated check results unavailable for this step'); expect(details.textContent).not.toContain('Unattributed later command'); }
  });

  it('names each automated check and its result on that journey step', async () => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'pricing-refresh');
    const checkStep = task.journey!.findLast((step) => step.kind === 'petrina' && step.work === 'checks')!;
    checkStep.productChecks = [{ name: 'Type check', result: 'pass', run: completedRun('Type check', 0) }, { name: 'Tests', result: 'fail', run: completedRun('Tests', 7) }];
    await mount(state);
    await openTask('pricing-refresh');
    const checkItem = host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${checkStep.id}"]`)!;
    await act(async () => checkItem.click());
    const details = host.querySelector('.journey-details')!;
    expect(details.textContent).toContain('Type check');
    expect(details.textContent).toContain('Passed');
    expect(details.textContent).toContain('Tests');
    expect(details.textContent).toContain('Failed');
  });

  it('shows running and pending checks beside completed results', async () => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'pricing-refresh');
    const step = task.journey!.findLast((step) => step.kind === 'petrina' && step.work === 'checks')!;
    step.productChecks = [{ name: 'Type check', result: 'pass', run: completedRun('Type check', 0), startedAt: NOW - 60_000, endedAt: NOW - 50_000 }, { name: 'Tests', result: 'running', startedAt: NOW - 120_000 }, { name: 'Commit message hook', result: 'pending' }];
    await mount(state);
    await openTask(task.id);
    await act(async () => host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${step.id}"]`)!.click());
    const items = [...host.querySelectorAll('.journey-details .journey-check-list li')].map((item) => item.textContent);
    expect(items[0]).toContain('PassedType check');
    expect(items[1]).toContain('RunningTests2m so far');
    expect(items[2]).toContain('PendingCommit message hook');
  });

  it('separates interrupted and failed attempts from the latest passing rerun', async () => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'pricing-refresh');
    const step = task.journey!.findLast((step) => step.kind === 'petrina' && step.work === 'checks')!;
    step.productChecks = [
      { id: 'check-0', name: 'Tests', result: 'stopped', detail: 'Original interruption', startedAt: NOW - 90_000, endedAt: NOW - 80_000 },
      { id: 'run-1:check-0', name: 'Tests', result: 'fail', run: completedRun('Tests', 7, 'Original failure'), detail: 'Original failure', startedAt: NOW - 60_000, endedAt: NOW - 50_000 },
      { id: 'run-2:check-0', attemptId: 'run-2', productId: task.productId, queuedAt: NOW - 30_000, name: 'Tests', result: 'pass', run: completedRun('Tests', 0), startedAt: NOW - 20_000, endedAt: NOW - 10_000 },
    ];
    await mount(state);
    await openTask(task.id);
    await act(async () => host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${step.id}"]`)!.click());
    const details = host.querySelector('.journey-details')!;
    expect(details.textContent).toContain('Latest attempt · 1 of 1 passed');
    const earlier = [...details.querySelectorAll<HTMLDetailsElement>('.check-attempt-history')];
    expect(earlier).toHaveLength(2);
    expect(earlier.every((entry) => !entry.open)).toBe(true);
    expect(earlier[0]!.querySelector('summary')?.textContent).toContain('Earlier attempt 2 · 1 of 1 failed');
    expect(earlier[0]!.textContent).toContain('Original failure');
    expect(earlier[1]!.querySelector('summary')?.textContent).toContain('Stopped — verification incomplete');
    expect(earlier[1]!.textContent).not.toContain('Interrupted — verification incomplete');
    expect(earlier[1]!.textContent).toContain('Original interruption');
    expect(details.querySelector('.check-attempt')?.textContent).toContain('PassedTests');
    expect(details.querySelector('.check-attempt')?.textContent).not.toContain('Original failure');
    expect(details.querySelector('.check-attempt')?.textContent).toContain(`Started ${new Date(NOW - 30_000).toLocaleString()} · <1m elapsed`);
    expect(earlier[0]!.textContent).toContain(`Started ${new Date(NOW - 60_000).toLocaleString()} · <1m elapsed`);
    expect(earlier[1]!.textContent).toContain(`Started ${new Date(NOW - 90_000).toLocaleString()} · <1m elapsed`);
  });

  it.each([false, true])('annotates confirmed interruption beside a real failure=%s while retaining original diagnostics', async (mixed) => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'pricing-refresh');
    const step = task.journey!.find((step) => step.work === 'checks')!;
    const originalOutcome = step.outcome;
    const failed = { ...step.productChecks![0]!, result: 'fail' as const, run: { ...step.productChecks![0]!.run!, ok: false, execution: completeCheckExecution(7), output: 'Completed failure before sleep' }, detail: 'Completed failure before sleep' };
    const run = { ...step.productChecks![1]!.run!, ok: false, output: 'Original startup failure', interruption: { source: 'macOS power log' as const, at: NOW - 90_000, event: 'Entering Sleep state due to Clamshell Sleep' } };
    step.productChecks = [...(mixed ? [failed] : []), { ...step.productChecks![1]!, result: 'fail', run, detail: 'Original startup failure' }];
    await mount(state); await openTask(task.id);
    await act(async () => host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${step.id}"]`)!.click());
    const details = host.querySelector('.journey-details')!;
    expect(details.textContent).toContain('Interrupted — verification incomplete');
    expect(details.textContent).toContain('Original reported result: failed');
    expect(details.textContent).toContain('Original startup failure');
    expect(details.textContent).toContain('macOS power log');
    if (mixed) {
      expect(details.textContent).toContain('1 still failing, 1 unverified');
      expect(details.textContent).toContain('Completed failure before sleep');
      expect(details.querySelectorAll('.label.bad')).toHaveLength(1);
    }
    expect(step.outcome).toBe(originalOutcome);
  });

  it('shows the failed test behind a delivery checkpoint, not just “checks still fail”', async () => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'pricing-refresh');
    const deliveryIndex = task.journey!.findIndex((step) => step.kind === 'you' && step.waitsFor === 'delivery');
    const checkStep = task.journey!.find((step) => step.kind === 'petrina' && step.work === 'checks')!;
    task.journey = [...task.journey!.slice(0, deliveryIndex), { ...checkStep, id: 'checks-before-delivery', startedAt: NOW - 100, endedAt: NOW - 10 }, ...task.journey!.slice(deliveryIndex)];
    task.checks = { at: NOW, definition: 'current', results: [
      { name: 'Type check', command: 'bun run typecheck', ok: true, execution: completeCheckExecution(0), ms: 10, output: 'passed' },
      { name: 'Tests', command: 'bun run test', ok: false, execution: completeCheckExecution(7), ms: 100, output: '@petrina/engine:test  | (fail) reviews after a usage handoff > keeps a real reviewer handoff independent with 1 pool slots and one slot per tool [66762.68ms]\n@petrina/engine:test  | error: Timed out waiting for the independent reviews' },
      { name: 'Desktop shell', command: 'cargo check', ok: true, execution: completeCheckExecution(0), ms: 10, output: 'passed' },
    ] };
    delete task.journey!.findLast((step) => step.kind === 'you' && step.waitsFor === 'delivery')!.productChecks;
    await mount(state);
    await openTask('pricing-refresh');
    const delivery = task.journey!.find((step) => step.kind === 'you' && step.waitsFor === 'delivery')!;
    await act(async () => host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${delivery.id}"]`)!.click());
    const details = host.querySelector('.journey-details')!;
    expect(details.textContent).toContain('Checks behind this delivery decision');
    expect(host.querySelector('#journey-details-title')?.textContent).toContain('Your call: checks still failing');
    expect(details.textContent).toContain('Tests');
    expect(details.textContent).toContain('Failed');
    expect(details.textContent).toContain('keeps a real reviewer handoff independent');
    expect(details.textContent).toContain('Timed out waiting for the independent reviews');
  });

  it.each([false, true])('links reused passing=%s evidence after an unchanged Builder and offers the right coordinator action', async (passed) => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'pricing-refresh') as DeepMutable<Task>;
    task.after = ['guest-checkout'];
    const original = task.journey!.find((step) => step.work === 'checks')!;
    const run = { ...original.productChecks!.find((check) => check.name === 'Tests')!.run!, ok: passed, execution: completeCheckExecution(passed ? 0 : 7), output: passed ? 'passed' : 'Startup cause remains unresolved', startedAt: NOW - 90_000, endedAt: NOW - 49_000 };
    const source = run.source!;
    original.productChecks = [{ id: source.checkId, attemptId: source.attemptId, productId: task.productId, name: run.name, result: passed ? 'pass' : 'fail', run }];
    task.checks = { at: NOW - 49_000, current: true, results: [run] };
    if (passed) {
      // This branch promises a complete recorded pass; legacy/missing setup stays in the failed branch below.
      const beforeSetup = setupObservation(task.productId, 0, NOW - 91_000);
      const setup = setupObservation(task.productId, 0, NOW - 48_000); setup.position = "after-checks";
      original.checkSetups = [beforeSetup, setup];
      task.checkSetup = setup;
      run.executor = setup.executor;
      task.checks = { ...task.checks, sha: setup.input.sha, tree: setup.input.tree, definition: setup.input.definition,
        environment: { ...setup.identity!, setupAttempts: { before: beforeSetup.id, after: setup.id } } };
    }
    if (passed) expect(recordedCheckBatch(task).kind).toBe("passed");
    task.journey = task.journey!.slice(0, task.journey!.indexOf(original) + 1);
    const builderIndex = task.plan!.stages.findIndex((stage) => stage.roleId === 'builder');
    task.stageIndex = builderIndex; task.fixing = true;
    const outcome = passed ? 'No code changes' : 'No code changes; checks still failing';
    const builder = beginAgentStep(task, 'builder', task.plan!.stages[builderIndex]!.profileIds[0]!, NOW - 40_000, state.roles);
    builder.builderReturn = { productId: task.productId, changed: false, claimedFixes: 0, outcome };
    builder.agentResults = [{ roleId: 'builder', profileId: builder.profileId!, at: NOW - 20_000, value: { summary: 'Investigated the startup problem.' } }];
    task.findings = passed ? [] : [{ id: 'unresolved', text: 'Check failed: Tests', raisedBy: 'petrina', confirmedBy: [], severity: 'blocking', status: 'open', answer: { fixed: false, text: 'The environment is a suspected cause.', at: NOW - 20_000 } }];
    builder.findingIds = task.findings.map(finding => finding.id);
    recordStepResult(task, { findings: task.findings });
    endAgentStep(task, { outcome, reason: outcome }, NOW - 20_000);
    task.fixing = false;
    recordCheckReuse(task, task, NOW - 10_000);
    const reuse = task.journey!.at(-1)!;
    task.stageIndex = task.plan!.stages.findIndex((stage) => stage.gate === 'delivery');
    const decision = beginYouStep(task, 'delivery', NOW - 5_000); decision.productChecks = decisionEvidence(task);
    task.statusLine = passed ? 'Reviews done. Waiting for your OK to ship' : 'Checks still fail. Your call';
    await mount(state); await openTask(task.id);
    const overview = host.querySelector('.task-global-details')!;
    expect(overview.textContent).toContain('Latest Builder return');
    expect(overview.textContent).toContain(builderCheckSummary(task));
    expect(overview.textContent).toContain('Start after other tasks land');
    expect(overview.querySelector('.dependency-selection a')?.getAttribute('href')).toContain('/tasks/guest-checkout');
    await act(async () => host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${reuse.id}"]`)!.click());
    const details = host.querySelector('.journey-details')!;
    expect(details.textContent).toContain(passed ? '1 of 1 passed' : '1 of 1 failed');
    expect(details.textContent).toContain('no new execution');
    expect(details.textContent).toContain('recorded duration');
    const link = details.querySelector<HTMLAnchorElement>('a[href*="attempt="]')!;
    expect(link.href).toContain(`node=${source.stepId}`);
    await act(async () => link.click());
    expect(window.location.search).toContain(`attempt=${source.attemptId}`);
    expect(host.querySelector('#journey-details-title')?.textContent).toContain('Automated checks');
    expect(host.querySelector('.journey-details .check-attempt')?.textContent).toContain(`Started ${new Date(run.startedAt).toLocaleString()}`);
    await act(async () => host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${decision.id}"]`)!.click());
    expect(host.querySelector('.journey-details')?.textContent).toContain('Checks behind this delivery decision');
    expect(host.querySelector('.journey-details')?.textContent).toContain(passed ? 'Passed' : 'Startup cause remains unresolved');
    const request = [...host.querySelectorAll<HTMLElement>('.ask')].find((item) => item.textContent?.includes('Refresh the pricing page') && item.textContent?.includes(passed ? deliveryLabel(task) : 'Run checks again'))!;
    expect(request).toBeTruthy();
    expect(request.querySelector('.ask-actions .lead svg')?.classList.contains(passed ? 'lucide-git-pull-request' : 'lucide-rotate-cw')).toBe(true);
    if (!passed) {
      expect(request.textContent).not.toContain('Open pull request');
      const sameSimulator = simulator;
      await act(async () => request.querySelector<HTMLAnchorElement>('a[href*="attempt="]')!.click());
      expect(simulator).toBe(sameSimulator);
      expect(window.location.search).toContain(`node=${source.stepId}`);
      expect(window.location.search).toContain(`attempt=${source.attemptId}`);
      expect(host.querySelector('#journey-details-title')?.textContent).toContain('Automated checks');
      await act(async () => [...request.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Send back…')!.click());
      expect(request.querySelector('input[placeholder="What should change?"]')).toBeTruthy();
    }
    await act(async () => host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${builder.id}"]`)!.click());
    expect([...host.querySelectorAll('.journey-details h4')].map(heading => heading.textContent)).toContain('Builder’s report');
    if (!passed) expect(host.querySelector('.journey-details')?.textContent).toContain('Builder’s explanation — not independently confirmed');
    expect(host.querySelector('.journey-details')?.textContent).not.toContain('Recorded machine evidence');
  });

  it.each([false, true])('retains the check decision after outdated interrupted=%s evidence', async (interrupted) => {
    const state = createDemoState(NOW), task = taskOf(state, 'pricing-refresh');
    task.checks = { at: NOW - 1, current: false, results: [{ name: 'Tests', command: 'tests', ms: 100, ok: false, execution: completeCheckExecution(7), output: 'Original diagnostic', ...(interrupted ? { interruption: { source: 'macOS power log', at: NOW - 1000, event: 'Sleep' } } : {}) }] };
    task.findings = [];
    task.statusLine = gateStatus(task, 'delivery');
    const item = state.inbox.find(item => item.taskId === task.id && item.kind === 'delivery')!;
    item.title = gateTitle(task, 'delivery');
    const decision = task.journey!.findLast(step => step.waitsFor === 'delivery')!;
    decision.productChecks = decisionEvidence(task);
    await mount(state); await openTask(task.id);
    await act(async () => host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${decision.id}"]`)!.click());
    const request = [...host.querySelectorAll('.ask')].find(ask => ask.textContent?.includes(task.title))!;
    const words = interrupted ? 'checks unverified' : 'checks still failing';
    expect(request.textContent).toContain(`Your call: ${words}`);
    expect(request.textContent).toContain('Run checks again');
    expect(request.textContent).not.toContain('Open a pull request');
    expect(host.querySelector('#journey-details-title')?.textContent).toContain(`Your call: ${words}`);
    expect(builderCheckSummary(task)).toContain('Checks need updating');
    expect(builderCheckSummary(task)).toContain(interrupted ? 'Earlier checks were unverified' : 'Earlier checks failed');
  });

  it('does not invent original runs or links when a delivery has no evidence', async () => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'pricing-refresh');
    task.checks = undefined;
    task.journey = task.journey!.filter(step => step.work !== 'checks');
    const decision = task.journey!.find(step => step.waitsFor === 'delivery')!;
    delete decision.productChecks;
    await mount(state); await openTask(task.id);
    await act(async () => host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${decision.id}"]`)!.click());
    const details = host.querySelector('.journey-details')!.textContent;
    expect(details).toContain('Original check evidence unavailable');
    expect(details).not.toContain('Checks ran');
    expect(details).not.toContain('linked below');
  });
  it.each([false, true])('shows only the selected step local setup (missing=%s)', async missing => {
    const state = createDemoState(NOW), task = taskOf(state, 'pricing-refresh');
    const step = task.journey!.findLast(step => step.kind === 'petrina' && step.work === 'checks')!;
    task.checkSetup = setupObservation(task.productId, 0, NOW);
    if (missing) delete step.checkSetups;
    else step.checkSetups = [setupObservation(task.productId, 7, NOW - 60_000)];
    await mount(state); await openTask(task.id);
    await act(async () => host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${step.id}"]`)!.click());
    const local = host.querySelector('.journey-details .check-setup-observations');
    if (missing) expect(host.querySelector('.journey-details')?.textContent).toContain('No local setup observation was recorded for this step.');
    else { expect(local?.textContent).toContain('Compiler version did not pass (exit 7)'); expect(local?.textContent).toContain('Before automated checks'); }
    expect(local?.textContent ?? '').not.toContain('Local setup was verified');
  });

});
