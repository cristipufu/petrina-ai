import { act, useState, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoState, ROLE_STARTS, Simulator } from '@petrina/core';
import { RolePanel, RolesSection, type RolePanelTarget } from '../src/components/Roles';

let simulator: Simulator;
vi.mock('../src/engine', () => ({ sim: new Proxy({}, { get: (_, name) => (...args: unknown[]) => (simulator[name as keyof Simulator] as Function).apply(simulator, args) }) }));

function Library() {
  const state = useSyncExternalStore((notify) => simulator.subscribe(notify), () => simulator.getState());
  const [target, setTarget] = useState<RolePanelTarget>();
  return <><RolesSection state={state} onOpen={setTarget} />{target && <RolePanel key={JSON.stringify(target)} state={state} target={target} onClose={() => setTarget(undefined)} />}</>;
}
let root: Root;
let host: HTMLDivElement;
const panel = () => host.querySelector<HTMLElement>('.role-panel') ?? host.querySelector<HTMLElement>('.sheet.panel')!;
const card = (name: string) => [...host.querySelectorAll<HTMLElement>('.role-card')].find((entry) => entry.querySelector('h3')?.textContent === name)!;
const button = (name: string | RegExp, scope: ParentNode = host) => {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((entry) => {
    const label = entry.getAttribute('aria-label') ?? entry.textContent!.trim();
    return typeof name === 'string' ? label === name : name.test(label);
  });
  expect(found, String(name)).toBeDefined();
  return found!;
};
const field = (label: string) => {
  const found = [...panel().querySelectorAll<HTMLLabelElement>('label')].find((entry) => entry.textContent === label)?.control;
  expect(found, label).not.toBeNull();
  return found as HTMLInputElement | HTMLTextAreaElement;
};
async function click(name: string | RegExp, scope?: ParentNode) { await act(async () => button(name, scope).click()); }
async function fill(label: string, value: string) {
  await act(async () => {
    const input = field(label);
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function add(start: string) {
  await click('Add a role');
  const entry = ROLE_STARTS.find((entry) => entry.id === start)!;
  await click(start === 'blank' ? entry.label : `Start from a ${entry.label}`);
}
beforeEach(async () => {
  const initial = createDemoState(1_000_000_000);
  simulator = new Simulator({ ...initial, tasks: [], inbox: [], pool: { ...initial.pool, paused: true } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Library />));
});
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });

describe('the Library role forms', () => {
  it('labels every built-in card and offers View only for the Release Manager', async () => {
    const roles = simulator.getState().roles;
    expect(host.querySelectorAll('.role-card')).toHaveLength(roles.length);
    for (const role of roles) {
      expect(card(role.name).textContent).toContain('Built-in');
      expect(card(role.name).textContent).not.toContain('Edited');
      expect(button(`${role.id === 'release-manager' ? 'View' : 'Edit'} the ${role.name}`, card(role.name))).toBeDefined();
    }
    await click('View the Release Manager');
    expect(panel().textContent).toContain("It can't be edited here.");
    expect(panel().querySelector('input,textarea,select')).toBeNull();
    expect(panel().textContent).not.toContain('Reset to default');
    expect(panel().textContent).not.toContain('Remove role');
    await click('Close', panel());
    expect(panel()).toBeNull();
  });

  it('saves explicitly with Command+Enter, marks Edited, and confirms before resetting', async () => {
    const original = simulator.getState().roles.find((role) => role.id === 'researcher')!;
    await click('Edit the Researcher');
    await fill("What it's for", 'Checks the facts people need.');
    await fill('How it works', 'Check every claim against its source.');
    expect(simulator.getState().roles.find((role) => role.id === original.id)?.instructions).toBe(original.instructions);
    await act(async () => field('How it works').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })));
    expect(panel()).toBeNull();
    expect(card('Researcher').textContent).toContain('Built-in·Edited');
    expect(simulator.getState().roles.find((role) => role.id === original.id)?.instructions).toBe('Check every claim against its source.');
    await click('Edit the Researcher');
    await click('Reset to default', panel());
    const confirmation = host.querySelector('[role=alertdialog]')!;
    expect(confirmation.textContent).toContain('Your changes to this role are lost.');
    await click('Cancel', confirmation);
    expect(simulator.getState().roles.find((role) => role.id === original.id)?.edited).toBe(true);
    await click('Reset to default', panel());
    await click('Reset to default', host.querySelector('[role=alertdialog]')!);
    expect(panel()).toBeNull();
    expect(simulator.getState().roles.find((role) => role.id === original.id)).toEqual(original);
    expect(card('Researcher').textContent).not.toContain('Edited');
  });

  it.each([
    ['outside', 'Keep editing', 'metaKey'],
    ['Cancel', 'Keep editing', 'metaKey'],
    ['Close', 'Keep editing', 'metaKey'],
    ['Escape', 'Keep editing', 'metaKey'],
    ['outside', 'Escape', 'ctrlKey'],
    ['outside', 'outside', 'metaKey'],
  ])('returns to the role form after %s then %s, so %s+Enter saves', async (close, keep, modifier) => {
    const original = simulator.getState().roles.find((role) => role.id === 'researcher')!;
    await click('Edit the Researcher');
    const purpose = field("What it's for");
    await act(async () => purpose.focus());
    await fill("What it's for", 'Checks facts against their sources.');
    if (close === 'outside') {
      // A real pointer click on a non-focusable scrim leaves focus on the page body.
      await act(async () => { purpose.blur(); host.querySelector<HTMLElement>('.scrim')!.click(); });
    } else if (close === 'Escape') {
      await act(async () => purpose.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    } else {
      await act(async () => button(close, panel()).focus());
      await click(close, panel());
    }
    expect(host.querySelector('[role=alertdialog]')).not.toBeNull();
    expect(simulator.getState().roles.find((role) => role.id === original.id)).toEqual(original);
    if (keep === 'Escape') {
      await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    } else if (keep === 'outside') {
      await act(async () => { (document.activeElement as HTMLElement).blur(); host.querySelector<HTMLElement>('.dialog-scrim')!.click(); });
    } else {
      await click('Keep editing', host.querySelector('[role=alertdialog]')!);
    }
    expect(host.querySelector('[role=alertdialog]')).toBeNull();
    expect(panel().contains(document.activeElement)).toBe(true);
    if (close !== 'outside') expect(document.activeElement).toBe(close === 'Escape' ? purpose : button(close, panel()));
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', [modifier!]: true, bubbles: true, cancelable: true })));
    expect(panel()).toBeNull();
    expect(simulator.getState().roles.find((role) => role.id === original.id)?.purpose).toBe('Checks facts against their sources.');
    expect(card('Researcher').textContent).toContain('Edited');
  });

  for (const [id, guidance] of [
    ['check-finder', 'Hand back between one and eight checks'],
    ['guide-keeper', 'Do not repeat a point the guide already has'],
    ['verifier', 'real but small, it should not hold the work back'],
    ['security-reviewer', 'Report a whole class of problem once'],
  ]) {
    it(`shows and saves the ${id}'s full How it works wording`, async () => {
      const role = simulator.getState().roles.find((entry) => entry.id === id)!;
      await click(`Edit the ${role.name}`);
      expect(field('How it works').value).toBe(role.instructions);
      expect(field('How it works').value).toContain(guidance);
      const changed = `${role.instructions}\nCheck the welcome page too.`;
      await fill('How it works', changed);
      await click(/^Save/, panel());
      expect(simulator.getState().roles.find((entry) => entry.id === id)?.instructions).toBe(changed);
      expect(card(role.name).textContent).toContain('Edited');
    });
  }

  for (const start of ROLE_STARTS) {
    it(`adds a role ${start.label.toLowerCase()}, with an Added by you card and a locked result after saving`, async () => {
      await add(start.id);
      if (start.id === 'blank') {
        await fill('Name', 'Fact checker');
        await fill("What it's for", 'Checks every claim.');
        await fill('How it works', 'Read the source for every claim.');
        await fill('Describe what it hands back', 'Claims checked and any gaps.');
      }
      const name = field('Name').value;
      const result = start.draft.result;
      expect(panel().querySelector('[role=radiogroup][aria-labelledby$="-icon"]')).not.toBeNull();
      expect(panel().querySelector('[role=radiogroup][aria-labelledby$="-tone"]')).not.toBeNull();
      await click(/^Save/, panel());
      expect(panel()).toBeNull();
      expect(card(name).textContent).toContain('Added by you');
      expect(simulator.getState().roles.find((role) => role.name === name)?.result).toBe(result);
      await click(`Edit the ${name}`);
      expect(panel().textContent).toContain('To hand back something else, add a new role.');
      expect(panel().querySelector('[name$="-result"]')).toBeNull();
    });
  }

  for (const [label, value, message] of [
    ['Name', '', 'Give the role a name.'],
    ["What it's for", '', 'Say what the role is for.'],
    ['Name', 'bUiLdEr', 'There is already a role called “Builder”. Pick another name.'],
    ['Name', 'x'.repeat(41), 'Keep the name to 40 characters. It has 41.'],
    ["What it's for", 'x'.repeat(201), 'Keep this to 200 characters. It has 201.'],
    ['How it works', 'x'.repeat(4001), 'Keep this to 4,000 characters. It has 4,001.'],
    ['Describe what it hands back', 'x'.repeat(301), 'Keep this to 300 characters. It has 301.'],
  ]) {
    it(`explains an invalid ${label}: ${message}`, async () => {
      await add('copywriter');
      await fill(label!, value!);
      await click(/^Save/, panel());
      expect(panel().textContent).toContain(message);
      expect(field(label!).getAttribute('aria-invalid')).toBe('true');
      expect(field(label!).getAttribute('aria-describedby')).toContain('-problem');
      expect(simulator.getState().roles.filter((role) => role.added)).toHaveLength(0);
    });
  }

  it('lists unfinished tasks before removing an added role, and leaves their plan intact', async () => {
    await add('copywriter');
    await click(/^Save/, panel());
    const added = simulator.getState().roles.find((role) => role.added)!;
    let taskId = '';
    await act(async () => {
      simulator.setPoolPaused(false);
      taskId = simulator.addTask({ productId: 'shop', title: 'Refresh the help text', kind: 'feature', approvePlan: true });
      for (let tick = 0; tick < 30 && !simulator.getState().tasks[0]?.plan; tick++) simulator.tick();
      simulator.setPoolPaused(true);
    });
    const plan = simulator.getState().tasks.find((task) => task.id === taskId)!.plan;
    expect(plan?.stages.some((stage) => stage.roleId === added.id)).toBe(true);
    await click(`Edit the ${added.name}`);
    await click('Remove role', panel());
    let confirmation = host.querySelector('[role=alertdialog]')!;
    expect(confirmation.textContent).toContain('This unfinished task uses it and will still run it:');
    expect(confirmation.textContent).toContain('Refresh the help text');
    await click('Cancel', confirmation);
    expect(card(added.name)).toBeDefined();
    await click('Remove role', panel());
    confirmation = host.querySelector('[role=alertdialog]')!;
    await click('Remove role', confirmation);
    expect(panel()).toBeNull();
    expect(card(added.name)).toBeUndefined();
    expect(simulator.getState().roles.find((role) => role.id === added.id)?.removed).toBe(true);
    expect(simulator.getState().tasks.find((task) => task.id === taskId)!.plan).toEqual(plan);
  });
});
