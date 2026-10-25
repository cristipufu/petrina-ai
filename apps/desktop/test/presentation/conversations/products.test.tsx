vi.mock("../../../src/notify/channels", () => {
  const unexpected = () => { throw new Error("This presentation test did not request a native notification."); };
  return { platform: () => "linux", browserPermission: () => "unsupported", useBrowserPermission: () => "unsupported", askBrowser: async () => "unsupported",
    BrowserNotices: class { show = unexpected; test = unexpected; waiting() {} },
    shell: { show: unexpected, test: unexpected, badge: unexpected, onClick: unexpected, onRelaunch: unexpected } };
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: () => { throw new Error("This presentation test did not request a native desktop operation."); } }));

import { oneTaskFixture } from "../../fixtures/state";
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type SessionLine, type Task } from "@petrina/core";
import { Session, StepConversation } from '../../../src/components/Session';
import { lookup } from '../../../src/lib';

vi.mock('../../../src/engine', () => ({ mode: 'demo', desktop: false, sim: {}, useUnsent: () => [], useEngineStatus: () => ({ link: 'live' }) }));

let host: HTMLDivElement;

let root: Root;

beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });

afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

async function expand() { await act(async () => { const details = host.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')); }); }

for (const view of ['session', 'step']) {
  it(`names the product on messages and individual actions in the ${view} conversation`, async () => {
    const state = oneTaskFixture(1_000_000);
    const first = state.products[0]!, second = state.products[1]!;
    const lines: SessionLine[] = [
      { id: 'agent', at: 100, from: 'agent', roleId: 'builder', productId: first.id, text: 'I checked the page' },
      { id: 'you', at: 110, from: 'you', productId: second.id, text: 'Check this product too' },
      { id: 'read', at: 120, from: 'activity', productId: first.id, text: 'Reading the code' },
      { id: 'check', at: 130, from: 'activity', productId: second.id, text: 'Running the tests' },
      { id: 'shared', at: 140, from: 'activity', text: 'Thinking it through' },
      { id: 'plain', at: 150, from: 'agent', roleId: 'builder', text: 'The shared work is ready' },
    ];
    const task: Task = { ...state.tasks[0]!, state: 'running', session: lines };
    await act(async () => root.render(view === 'session'
      ? <Session.Log task={task} state={state} find={lookup(state)} scroller={{ current: host }} onTab={() => {}} />
      : <StepConversation taskId={task.id} find={lookup(state)} now={state.now} lines={lines} />));
    const names = host.querySelectorAll('.msg .name');
    expect(names[0]!.textContent).toContain(`Builder · ${first.name}`);
    expect(names[1]!.textContent).toContain(`You · ${second.name}`);
    expect(names[2]!.textContent).not.toContain(' · ');
    expect(host.querySelector('.activity li')).toBeNull();
    expect(host.querySelector('details')?.open).toBe(false);
    await expand();
    expect([...host.querySelectorAll('.activity li')].map((line) => line.textContent)).toEqual([
      `${first.name}: Reading the code`, `${second.name}: Running the tests`, 'Thinking it through',
    ]);
    expect(host.querySelector('details summary')?.textContent).toBe('3 agent actions');
    await act(async () => { const details = host.querySelector('details')!; details.open = false; details.dispatchEvent(new Event('toggle')); });
    expect(host.querySelector('.activity li')).toBeNull();
    expect(host.querySelector('.chat .bubble')?.textContent).toBe('I checked the page');
  });

  it(`keeps the saved product name after product removal in the ${view} conversation`, async () => {
    const initial = oneTaskFixture(1_000_000);
    const removed = { ...initial.products[0]!, name: 'Archived product API' };
    const state = { ...initial, products: initial.products.filter((product) => product.id !== removed.id), tasks: [] };
    const lines: SessionLine[] = [
      { id: 'agent', at: 100, from: 'agent', roleId: 'builder', productId: removed.id, text: 'I checked the earlier product' },
      { id: 'action', at: 110, from: 'activity', productId: removed.id, text: 'Reading the code' },
    ];
    const task: Task = { ...initial.tasks[0]!, state: 'done', session: lines, repositories: [{ productId: removed.id, delivery: 'pull-request', completedStages: [], source: { product: { ...removed, defaultBranch: 'main' }, start: { kind: 'default', branch: 'main' }, destination: { mode: 'pull-request', kind: 'new-pr', repo: removed.repo, branch: 'main' }, confirmed: true } }] };
    await act(async () => root.render(view === 'session'
      ? <Session.Log task={task} state={state} find={lookup(state)} scroller={{ current: host }} onTab={() => {}} />
      : <StepConversation taskId={task.id} repositories={task.repositories} find={lookup(state)} now={state.now} lines={lines} />));
    expect(host.querySelector('.msg .name')?.textContent).toContain(`Builder · ${removed.name}`);
    await expand();
    expect(host.querySelector('.activity li')?.textContent).toBe(`${removed.name}: Reading the code`);
  });
}
