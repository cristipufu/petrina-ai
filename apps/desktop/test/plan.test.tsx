import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoState, ROLE_STARTS, Simulator, type Stage, type State } from '@petrina/core';
import { PlanView } from '../src/components/sheet/PlanTab';
import { lookup } from '../src/lib';

vi.mock('../src/engine', () => ({ sim: {} }));

let root: Root;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });

describe('the Plan tab', () => {
  it('shows the name and icon of a reviewer added before the task was planned', async () => {
    const initial = createDemoState(1_000_000_000);
    const simulator = new Simulator({ ...initial, tasks: [], inbox: [] });
    const roleId = simulator.addRole(ROLE_STARTS.find((start) => start.id === 'security')!.draft);
    const taskId = simulator.addTask({ productId: initial.products[0]!.id, title: 'Check the greeting', kind: 'bug', approvePlan: true });
    for (let tick = 0; tick < 20 && !simulator.getState().tasks[0]?.plan; tick += 1) simulator.tick();
    const state: State = simulator.getState();
    const task = state.tasks.find((entry) => entry.id === taskId)!;
    expect(task.plan!.stages.find((stage) => stage.kind === 'review-chain')!.roleIds).toContain(roleId);

    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<PlanView task={task} state={state} find={lookup(state)} />));

    const review = [...host.querySelectorAll('.stage')].find((stage) => stage.textContent?.includes('At the same time'))!;
    const stage = task.plan!.stages.find((stage) => stage.kind === 'review-chain')!;
    const rows = [...review.querySelectorAll('.who > .row')];
    expect(rows).toHaveLength(stage.profileIds.length);
    expect(review.querySelectorAll('.avatar')).toHaveLength(stage.profileIds.length);
    for (const [index, row] of rows.entries()) {
      const role = state.roles.find((role) => role.id === (stage.roleIds?.[index] ?? stage.roleId))!;
      expect(row.textContent?.split(role.name)).toHaveLength(2);
      expect(row.querySelectorAll('.avatar')).toHaveLength(1);
      expect(row.querySelector('select')?.value).toBe(stage.profileIds[index]);
    }
    expect(review.textContent).toContain(state.roles.find((role) => role.id === roleId)!.name);
    expect(review.querySelector('.avatar svg.lucide-shield')).not.toBeNull();
    expect(review.textContent).not.toContain(roleId);
  });

  for (const roleIds of [undefined, ['code-reviewer'], ['code-reviewer', 'code-reviewer']]) {
    it(`labels each reviewer once when reviewer roles are ${roleIds ? roleIds.length === 1 ? 'partly named' : 'all named' : 'not named'}`, async () => {
      const state = createDemoState(1_000_000_000);
      const original = state.tasks.find((task) => task.plan)!;
      const stage: Stage = { id: 'review', kind: 'review-chain', title: 'Review', roleId: 'code-reviewer', roleIds, profileIds: state.profiles.slice(0, 2).map((profile) => profile.id) };
      const task = { ...original, state: 'running' as const, stageIndex: -1, plan: { ...original.plan!, stages: [stage] } };
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
      await act(async () => root.render(<PlanView task={task} state={state} find={lookup(state)} />));

      const review = host.querySelector('.stage')!;
      const rows = [...review.querySelectorAll('.who > .row')];
      expect(rows).toHaveLength(2);
      expect(review.querySelectorAll('.avatar')).toHaveLength(2);
      expect(review.textContent?.split('Code reviewer')).toHaveLength(3);
      for (const [index, row] of rows.entries()) {
        expect(row.textContent?.split('Code reviewer')).toHaveLength(2);
        expect(row.querySelector('.avatar svg.lucide-search')).not.toBeNull();
        expect(row.querySelector('select')?.value).toBe(stage.profileIds[index]);
      }
    });
  }
});
