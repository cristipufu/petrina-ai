import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoState, type State, type Task } from '@petrina/core';
import { openTakeOver, TakeOverDialogs } from '../src/components/TakeOver';
import { lookup } from '../src/lib';

vi.mock('../src/engine', () => ({ mode: 'engine', sim: {} }));

let root: Root;
let host: HTMLDivElement;
afterEach(() => {
  act(() => {
    [...host.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')?.click();
    root?.unmount();
  });
  host?.remove();
});

describe('the Take over confirmation', () => {
  for (const { latest, started, permitted, saved } of [
    { latest: true, started: false, permitted: false, saved: false },
    { latest: false, started: true, permitted: true, saved: true },
    // A role planned after the final review runs read-only even if its saved role permits edits.
    { latest: true, started: true, permitted: false, saved: false },
  ]) {
    it(`describes a role started as ${started ? 'editing' : 'read-only'}, now ${latest ? 'editing' : 'read-only'} in the Library, with this step ${permitted ? 'editing' : 'read-only'}`, async () => {
      const initial = createDemoState(1_000_000_000);
      const current = { ...initial.roles.find((role) => role.id === 'researcher')!, canEdit: latest };
      const task: Task = {
        ...initial.tasks[0]!, state: 'running', holdsSlot: true, helpers: [],
        agent: { roleId: current.id, profileId: 'opus-high', since: initial.now, step: 0 },
        conversation: {
          step: 'research', roleId: current.id, profileId: 'opus-high', toolId: 'claude-code', model: 'opus',
          sessionId: 'test-session', startedAt: initial.now, briefed: true,
          role: { ...current, name: 'Original researcher', canEdit: started },
          access: { canEdit: permitted, afterReview: started && !permitted },
        },
      };
      const state: State = { ...initial, roles: initial.roles.map((role) => role.id === current.id ? current : role), tasks: [task] };
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
      await act(async () => {
        openTakeOver(task.id);
        root.render(<TakeOverDialogs state={state} find={lookup(state)} onToast={() => {}} />);
      });
      const words = host.querySelector('.prose')!.textContent;
      expect(words).toContain('Petrina stops the Original researcher first');
      expect(words).toContain(saved ? 'saves its unfinished work' : 'anything it left unsaved is undone');
      expect(words).not.toContain(saved ? 'anything it left unsaved is undone' : 'saves its unfinished work');
    });
  }
});
