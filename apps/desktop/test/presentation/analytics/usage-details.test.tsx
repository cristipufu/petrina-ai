

import { stateFixture } from "../../fixtures/state";
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type State, type WorkUsageLine } from "@petrina/core";
import { SplitList, UsageList } from "../../../src/components/Usage";

vi.mock('../../../src/engine', () => ({ mode: 'demo', desktop: false, sim: {} }));

let root: Root;

let host: HTMLDivElement;

async function show(state: State, expanded = false) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<UsageList state={state} expanded={expanded} />));
}

afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe('usage by tool', () => {
  it('says not reported in every missing model detail, including a completely missing token report', async () => {
    await show(stateFixture(1_000_000_000));
    const lines: WorkUsageLine[] = [
      { key: 'partial', label: 'A model', tokens: { value: 120, atLeast: false }, time: { atLeast: false }, detail: { input: 100, output: 20 } },
      { key: 'missing', label: 'Another model', tokens: { atLeast: true }, time: { value: 60_000, atLeast: false }, detail: {} },
    ];
    await act(async () => root.render(<SplitList title="By model" lines={lines} details color={() => 'blue'} />));
    const rows = [...host.querySelectorAll('.split-row:not(.head)')];
    expect([...rows[0]!.querySelectorAll('[role="cell"]')].slice(-4).map((cell) => cell.textContent)).toEqual(['100', 'not reported', 'not reported', '20']);
    expect([...rows[1]!.querySelectorAll('[role="cell"]')].slice(-4).map((cell) => cell.textContent)).toEqual(Array(4).fill('not reported'));
    expect(host.textContent).not.toMatch(/[—–]/);
  });
});
