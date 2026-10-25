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
import { Simulator, createDemoState, type State, type Task } from "@petrina/core";
import { App } from '../../../src/App';
import { lookup } from "../../../src/lib";

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

  it.each(['builder', 'architect', 'code-reviewer', 'tester', 'verifier'])('keeps message and terminal controls in the active %s node across its tabs', async (roleId) => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'guest-checkout');
    const role = state.roles.find((entry) => entry.id === roleId)!;
    task.state = 'running';
    task.agent = { roleId, profileId: 'sol-high', since: NOW - 1000, step: 0 };
    task.holdsSlot = true;
    delete task.helpers;
    delete task.conversation;
    state.inbox = state.inbox.filter((item) => item.taskId !== task.id);
    const prior = { ...task.journey![0]!, id: 'earlier', roleId: 'researcher', endedAt: NOW - 1000 };
    task.journey = [prior, { ...prior, id: 'active', roleId, profileId: 'sol-high', startedAt: NOW - 1000, endedAt: undefined, outcome: undefined, reason: undefined }];
    await mount(state);
    await openTask(task.id);
    await act(async () => host.querySelector<HTMLElement>('.journey-list [aria-current="step"]')!.click());
    const footer = host.querySelector('.task-agent-footer')!;
    expect(footer.textContent).toContain(`Message the ${role.name.toLowerCase()}`);
    expect(footer.textContent).toContain('Take over in terminal');
    expect(footer.querySelector<HTMLFormElement>('form')!.hidden).toBe(true);
    for (const tab of ['timeline', 'conversation', 'overview']) {
      await act(async () => host.querySelector<HTMLButtonElement>(`[data-journey-tab="${tab}"]`)!.click());
      expect(host.querySelector('.task-agent-footer')).toBe(footer);
    }
    await act(async () => footer.querySelector<HTMLButtonElement>('.composer-toggle')!.click());
    const field = footer.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Keep this guidance');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => footer.querySelector<HTMLButtonElement>('.composer-toggle')!.click());
    expect(footer.querySelector<HTMLFormElement>('form')!.hidden).toBe(true);
    expect(footer.textContent).toContain('Draft');
    expect(footer.textContent).toContain('Take over in terminal');
    await act(async () => footer.querySelector<HTMLButtonElement>('.composer-toggle')!.click());
    expect(footer.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Keep this guidance');
    await act(async () => host.querySelector<HTMLElement>('.journey-list li')!.click());
    expect(host.querySelector('.task-agent-footer')).toBeNull();
  });

  it('distinguishes repeated starts and keeps same-title input sections without key warnings', async () => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'pricing-refresh');
    const step = task.journey!.find((step) => step.roleId === 'builder')!;
    const input = { roleId: 'builder', profileId: step.profileId!, taskTitle: task.title, mode: 'fresh' as const, sections: [{ title: 'Requirements', body: 'Keep the selected delivery.' }, { title: 'Requirements', body: 'Keep the quoted total.' }] };
    step.agentInputs = [input, { ...input, sections: [] }, { ...input, reviewerKey: '0' }];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await mount(state);
      await openTask('pricing-refresh');
      const item = host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${step.id}"]`)!;
      await act(async () => item.click());
      const details = host.querySelector('.journey-details')!;
      const labels = [...details.querySelectorAll('.journey-agent-start summary')].map((summary) => summary.textContent!);
      expect(new Set(labels).size).toBe(labels.length);
      expect(labels.filter((label) => label.includes('Start 1'))).toHaveLength(2);
      expect(labels.filter((label) => label.includes('Start 2'))).toHaveLength(2);
      expect(labels.filter((label) => label.includes('Seat 1'))).toHaveLength(2);
      expect(labels.filter((label) => label.includes('Seat 1')).every((label) => !label.includes('Start'))).toBe(true);
      expect(details.textContent).toContain('Keep the selected delivery.');
      expect(details.textContent).toContain('Keep the quoted total.');
      expect(errors.mock.calls.filter((args) => /same key|unique.*key/i.test(args.join(' ')))).toEqual([]);
    } finally { errors.mockRestore(); }
  });

  it.each(['fresh', 'continued', 'reopened'] as const)('shows delivered coordinator guidance once in the input panel (%s)', async (mode) => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'pricing-refresh');
    const step = task.journey!.find((step) => step.roleId === 'builder')!;
    const text = 'Keep the original integrity requirement when checking the artifact.';
    const messages = { title: 'Messages from the coordinator, in order', body: `1. ${text}` };
    step.agentInputs = [{
      roleId: 'builder', profileId: step.profileId!, taskTitle: task.title,
      mode: mode === 'fresh' ? 'fresh' : 'continued',
      sections: mode === 'reopened' ? [] : [messages],
      ...(mode === 'reopened' ? { resumed: true, updates: [{ at: NOW, reason: 'continue' as const, text: `## ${messages.title}\n${messages.body}` }] } : {}),
    }];
    await mount(state);
    await openTask('pricing-refresh');
    await act(async () => host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${step.id}"]`)!.click());
    const input = host.querySelector('.journey-input-record')!;
    expect(input.textContent).toContain('Input given to Builder');
    expect(input.textContent!.split(text)).toHaveLength(2);
    expect(input.textContent).not.toContain("The coordinator's notes");
    if (mode === 'reopened') expect(input.querySelector('.journey-input-updates')?.textContent).toContain(text);
    else expect([...input.querySelectorAll('h4')].map(heading => heading.textContent)).toContain(messages.title);
  });

  it('explains a Builder fix assignment and shows the exact failed Tester check', async () => {
    const state = createDemoState(NOW);
    const task = taskOf(state, 'pricing-refresh');
    const builder = task.journey!.find((step) => step.roleId === 'builder')!;
    builder.agentInputs = [{ roleId: 'builder', profileId: builder.profileId!, taskTitle: task.title, taskDescription: task.description, stageTitle: 'Build', sections: [{ title: 'Implementation brief', body: 'Build the requested checkout changes.' }], mode: 'fresh' }];
    const tester = task.journey!.findLast((step) => step.work === 'checks' && step.endedAt !== undefined)!;
    tester.kind = 'agent';
    tester.roleId = 'tester';
    delete tester.work;
    tester.acceptanceChecks = [
      { text: 'Type checks and all tests pass.', result: 'fail', evidence: 'The Tests command timed out.' },
      { text: 'The total includes the selected shipping fee.', result: 'pass', evidence: 'The selected shipping fee is included.' },
      { text: 'A real account works.', result: 'blocked', reason: 'Account unavailable.' },
    ];
    tester.reason = 'one acceptance check failed';
    tester.outcome = '1 acceptance check failed';
    const testerIndex = task.journey!.indexOf(tester);
    task.journey = [...task.journey!.slice(0, testerIndex + 1), { ...builder, id: 'builder-fix-test', trigger: { after: tester.id, reason: 'A recorded acceptance failure' }, fixing: true, startedAt: NOW - 100, endedAt: NOW, builderConversation: 'resumed', reason: undefined, outcome: 'Fixes ready', agentInputs: [{ roleId: 'builder', profileId: builder.profileId!, taskTitle: task.title, stageTitle: 'Build', sections: [{ title: 'Review findings', body: 'The checkout total drops the selected shipping fee.' }], mode: 'continued' }] }];
    const fixInput = task.journey!.at(-1)!.agentInputs![0]!;
    fixInput.requestedProfileId = state.profiles[0]!.id;
    fixInput.selectionReason = 'The planned profile reached its weekly limit.';
    fixInput.confirmedSettings = { model: 'confirmed-model', effort: 'high' };
    fixInput.instructions = 'Correct the missing shipping fee, then check the total after changing delivery.';
    fixInput.updates = [{ at: NOW, reason: 'answer', text: 'The coordinator answered: keep the selected delivery method.' }];
    task.findings = [...task.findings, { id: 'finding-fix-1', text: 'The checkout total drops the selected shipping fee.', severity: 'blocking', raisedBy: 'code-reviewer', confirmedBy: [], status: 'open', answer: { fixed: false, text: 'The work still needs a correction.', at: NOW }, evidence: 'The displayed total excludes shipping after changing the delivery method.' }];
    task.brief = { summary: 'Keep the checkout total accurate.', forUsers: [], areas: [], risks: [], acceptance: [
      { text: 'Type checks and all tests pass.', verification: 'failed', met: false },
      { text: 'The total includes the selected shipping fee.', verification: 'passed', met: true },
    ] };
    await mount(state);
    await openTask('pricing-refresh');
    const firstBuilderItem = [...host.querySelectorAll<HTMLElement>('.journey-list li')].find((item) => /^\d+\. Builder\./.test(item.textContent ?? ''))!;
    await act(async () => firstBuilderItem.click());
    expect(host.querySelector('.journey-details')?.textContent).toContain('Task request');
    expect(host.querySelector('.journey-details')?.textContent).toContain(task.description);
    const builderItem = host.querySelector<HTMLElement>('.journey-list li[data-step-id="builder-fix-test"]')!;
    await act(async () => builderItem.click());
    let details = host.querySelector('.journey-details')!;
    expect(details.textContent).not.toContain('Task request');
    expect(details.textContent).not.toContain(task.description);
    expect(details.textContent).toContain('Input given to Builder');
    expect(details.querySelector('.journey-job')?.textContent).toContain(fixInput.instructions);
    expect(details.querySelector('.journey-input-updates')?.textContent).toContain(fixInput.updates[0]!.text);
    expect(details.textContent).toContain('Agent choice');
    expect(details.textContent).not.toContain('Recorded for you;');
    expect(details.querySelector('.journey-trigger h4')?.textContent).toBe('Why this step started');
    expect(details.querySelector('.journey-input-mode')?.textContent).toBe('Continued conversation');
    const sentInput = details.querySelector('.journey-input-record')!;
    expect(sentInput.querySelector('.agent-selection')).toBeNull();
    expect(sentInput.textContent).not.toContain(fixInput.selectionReason);
    expect(details.querySelector('.agent-selection')?.textContent).toContain(fixInput.selectionReason);
    expect(details.textContent).toContain('The planned profile reached its weekly limit.');
    expect(details.textContent).toContain('Tool confirmed at start: confirmed-model');
    expect(details.textContent).toContain('Type checks and all tests pass.');
    expect(details.textContent).not.toContain('A real account works.');
    expect(details.textContent).not.toContain('Builder conversation');
    expect(details.textContent).toContain('Findings assigned to this fix');
    expect(details.textContent).toContain('The checkout total drops the selected shipping fee.');

    const testerItem = host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${tester.id}"]`)!;
    await act(async () => testerItem.click());
    details = host.querySelector('.journey-details')!;
    expect(details.textContent).toContain('Type checks and all tests pass.');
    expect(details.textContent).toContain('Failed');
    const acceptanceItems = [...details.querySelectorAll('.journey-check-list li')].map((item) => item.textContent ?? '');
    expect(acceptanceItems[0]).toContain('The total includes the selected shipping fee.');
    expect(acceptanceItems[1]).toContain('Could not verify');
    expect(acceptanceItems[2]).toContain('Type checks and all tests pass.');
  });

  it('labels an older planner profile as planned, without claiming it actually ran', async () => {
    const state = createDemoState(NOW);
    await mount({ ...state, tasks: state.tasks.map((task) => {
      if (task.id !== 'pricing-refresh') return task;
      const { journey: _gone, ...older } = task;
      return older;
    }) });
    await openTask('pricing-refresh');
    const planner = host.querySelector<HTMLElement>('.journey-list li')!;
    expect(planner.textContent).toContain('Planned: Claude Code');
    await act(async () => planner.click());
    const details = host.querySelector('.journey-details')!;
    expect(details.textContent).toContain('Planned tool and model');
    expect(details.textContent).toContain('who actually ran it, its time and outcome were not recorded');
  });

  it('uses retired profiles to show an independent reviewer for a port', async () => {
  const state = createDemoState(NOW), task = taskOf(state, 'pricing-refresh');
  const oldBuilder = { ...state.profiles.find(profile => profile.id === 'sol-high')!, id: 'retired-builder' };
  const oldReviewer = { ...state.profiles.find(profile => profile.id === 'opus-high')!, id: 'retired-reviewer' };
  state.retiredProfiles = [oldBuilder, oldReviewer];
  task.state = 'paused'; task.journey = []; task.builderSession = undefined;
  task.plan = { rationale: 'Port', plannerProfileId: 'opus-high', stages: [{ id: 'build', kind: 'do', title: 'Build', roleId: 'builder', profileIds: [oldBuilder.id] }, { id: 'review', kind: 'review-chain', title: 'Review', roleId: 'code-reviewer', profileIds: [oldReviewer.id, 'sol-high'] }] };
  task.stageIndex = 1; task.reviewedTree = 'reviewed'; task.portReview = { from: 'before', head: 'after', onto: 'main', files: ['app.ts'] };
  await mount(state); await openTask(task.id);
  const review = [...host.querySelectorAll('.journey-list li')].find(node => node.textContent?.includes('Code reviewer'))!;
  expect(review.textContent).toContain('Claude Code');
  expect(review.textContent).not.toContain('Codex');
});

  it('shows the frozen maintenance role and profile when the Library no longer contains their settings', async () => {
  const state = createDemoState(NOW), task = taskOf(state, 'pricing-refresh');
  const frozen = { ...state.roles.find(role => role.result === 'build')!, id: 'saved-maintainer', name: 'Saved maintainer', category: 'maintenance' as const };
  const builder = task.journey!.find(step => step.roleId === 'builder')!;
  const profile = { ...state.profiles.find(profile => profile.id === builder.profileId)!, modelId: 'saved-native-model', model: 'Saved model' };
  task.maintenance = { routineId: 'routine', routineName: 'Routine', scheduledAt: 0, queuedAt: 0, zone: 'UTC', focus: 'Inspect', input: 'Inspect', role: frozen, profile, product: state.products[0]! };
  builder.roleId = frozen.id; builder.fixing = true; builder.findingIds = ['assigned-fix'];
  task.findings = [{ id: 'assigned-fix', text: 'Keep the saved contract.', severity: 'blocking', status: 'open', raisedBy: 'sol-high', confirmedBy: [] }];
  task.plan!.stages.filter(stage => stage.roleId === 'builder').forEach(stage => { stage.roleId = frozen.id; });
  await mount(state); await openTask(task.id);
  await act(async () => host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${builder.id}"]`)!.click());
  const details = host.querySelector('.journey-details')!;
  expect(details.querySelector('h3')?.textContent).toContain('Saved maintainer');
  expect(details.textContent).toContain(`${state.tools.find(tool => tool.id === profile.toolId)!.name} · Saved model`);
  expect(details.textContent).toContain('Findings assigned to this fix');
  expect(details.textContent).toContain('Keep the saved contract.');
  expect(lookup(state).role(frozen.id)).toBeUndefined();
});
});
