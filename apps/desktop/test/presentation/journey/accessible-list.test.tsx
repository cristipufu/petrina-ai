vi.mock("../../../src/notify/channels", () => {
  const unexpected = () => { throw new Error("This presentation test did not request a native notification."); };
  return { platform: () => "linux", browserPermission: () => "unsupported", useBrowserPermission: () => "unsupported", askBrowser: async () => "unsupported",
    BrowserNotices: class { show = unexpected; test = unexpected; waiting() {} },
    shell: { show: unexpected, test: unexpected, badge: unexpected, onClick: unexpected, onRelaunch: unexpected } };
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: () => { throw new Error("This presentation test did not request a native desktop operation."); } }));

import { vi } from "vitest";
vi.mock("../../../src/engine", () => ({ mode: "demo", desktop: false, sim: {} }));
import { act } from "react";
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDemoState, journeyView, type JourneyView, type State, type Task } from "@petrina/core";
import { JourneyList, spokenStep } from "../../../src/components/Journey";
import { layoutJourney } from '../../../src/journeyLayout';
import { lookup } from "../../../src/lib";

const NOW = 1_000_000_000_000;

let root: Root;

let host: HTMLDivElement;

const contextOf = (state: State) => ({ roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox, ...(state.planner ? { planner: state.planner } : {}) });

const taskOf = (state: State, id: string): Task => state.tasks.find((task) => task.id === id)!;

async function key(name: string) { await act(async () => { (document.activeElement ?? window).dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })); }); }

async function render(node: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(node)); }

beforeEach(() => localStorage.clear());

afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });

describe('the journey as a list, for screen readers and the keyboard', () => {
  const state = createDemoState(NOW);

  const view = journeyView(taskOf(state, 'pricing-refresh'), contextOf(state));

  const find = lookup(state);

  it('keeps long failure diagnostics in details without expanding the diagram arrows', () => {
    const failed = { ...view.nodes[2]!, state: 'failed' as const, reason: 'The provider refused this request. '.repeat(100) };
    const long = { ...view, nodes: [failed, view.nodes[3]!] };
    const short = { ...long, nodes: [{ ...failed, reason: 'stuck' }, view.nodes[3]!] };
    const geometry = (view: JourneyView) => {
      const { items, ...layout } = layoutJourney(view, 820, 16, 'Started');
      return { ...layout, items: items.map(({ node: _node, ...item }) => item) };
    };
    expect(geometry(long)).toEqual(geometry(short));
    expect(spokenStep(failed, 2, find, state.now)).toContain(`Stopped because: ${failed.reason}`);
  });

  it('reads each step: number, name, state, tool and model, time, outcome and why it moved on', async () => {
    const selected: string[] = [];
    await render(<JourneyList view={view} find={find} now={state.now} onFocusStep={() => {}} onSelect={(id) => selected.push(id)} />);
    const list = host.querySelector('ol')!;
    expect(list.getAttribute('aria-label')).toBe(`Journey, ${view.nodes.length} steps`);
    const items = [...list.querySelectorAll('li')].map((item) => item.textContent);
    expect(items[3]).toBe('4. Code reviewer. Done. Codex · GPT-6.1 Sol · high effort. 9m elapsed. 1 important. Moved on: sent back: 1 important.');
    expect(items[7]).toMatch(/^8\. Your delivery check\. Waiting for you\. Waiting \d+m so far\. Reviews done\. Waiting for your OK to ship\./);
    expect(items[8]).toBe('9. Publish delivery. Next.');
  });

  it('is one tab stop on the live step; the arrow keys move through it and Enter opens a step', async () => {
    const selected: string[] = [];
    const focused: (string | undefined)[] = [];
    await render(<JourneyList view={view} find={find} now={state.now} onFocusStep={(id) => focused.push(id)} onSelect={(id) => selected.push(id)} />);
    const items = [...host.querySelectorAll('li')];
    expect(items.filter((item) => item.tabIndex === 0)).toEqual([items[7]]);
    expect(items[7]!.getAttribute('aria-current')).toBe('step');
    await act(async () => items[7]!.focus());
    await key('ArrowUp');
    expect(document.activeElement).toBe(items[6]);
    await key('Home');
    expect(document.activeElement).toBe(items[0]);
    await key('End');
    expect(document.activeElement).toBe(items.at(-1));
    await key('ArrowLeft');
    await key('Enter');
    expect(selected).toEqual([view.nodes[7]!.id]);
    expect(focused.at(-1)).toBe(view.nodes[7]!.id);
    expect(items.filter((item) => item.tabIndex === 0)).toHaveLength(1);
  });

  it('says what a question or permission asked, and how you answered', () => {
    const asking = journeyView(taskOf(state, 'guest-checkout'), contextOf(state));
    const builder = asking.nodes.findIndex((node) => node.name === 'Builder');
    expect(spokenStep(asking.nodes[builder]!, builder, find, state.now)).toMatch(/Builder\. Waiting for you\. Codex · GPT-6.1 Sol · high effort\. \d+m elapsed so far\. Waiting for your permission\. Permission: Add a new package: Stripe\.js\. Waiting for you\.$/);
  });
});
