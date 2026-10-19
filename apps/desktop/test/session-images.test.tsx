import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDemoState, type SessionLine } from '@petrina/core';
import { Session, StepConversation } from '../src/components/Session';
import { Journey } from '../src/components/Journey';
import { lookup } from '../src/lib';

const { image } = vi.hoisted(() => ({ image: vi.fn() }));
vi.mock('../src/engine', () => ({ mode: 'demo', desktop: false, sim: { image, synced: () => true }, useUnsent: () => [], useEngineStatus: () => ({ link: 'live' }) }));
let host: HTMLDivElement;
let root: Root;
const revoked = vi.fn();
beforeEach(() => {
  image.mockResolvedValue(new Blob(['picture'], { type: 'image/png' }));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:checked-page');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoked);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); image.mockReset(); revoked.mockReset(); });
async function render(session: SessionLine[]) {
  const state = createDemoState(1_000_000);
  const task = { ...state.tasks[0]!, id: 'guest-checkout', session };
  await act(async () => root.render(<Session.Log task={task} state={state} find={lookup(state)} scroller={{ current: host }} onTab={() => {}} />));
}
it('loads a picture separately beside its originating report, keeps the caption, and releases it on exit', async () => {
  await render([
    { id: 'build-report', at: 100, from: 'agent', roleId: 'builder', text: 'Checked the page', images: [{ id: 'picture-1', caption: 'The completed page check' }] },
    { id: 'review-report', at: 200, from: 'agent', roleId: 'code-reviewer', text: 'Review passed' },
  ]);
  expect(image).toHaveBeenCalledWith('guest-checkout', 'picture-1');
  const picture = host.querySelector('figure')!;
  expect(picture.closest('.msg')?.textContent).toContain('Builder');
  expect(picture.closest('.msg')?.textContent).toContain('Checked the page');
  expect(picture.querySelector('figcaption')?.textContent).toBe('The completed page check');
  expect(picture.querySelector('img')?.alt).toBe('The completed page check');
  expect(host.querySelectorAll('figure')).toHaveLength(1);
  await render([]);
  expect(revoked).toHaveBeenCalledWith('blob:checked-page');
});
it('keeps reports without pictures as text and fetches nothing', async () => {
  await render([{ id: 'plain', at: 100, from: 'agent', roleId: 'builder', text: 'All checks passed' }]);
  expect(host.querySelector('figure')).toBeNull();
  expect(image).not.toHaveBeenCalled();
  expect(host.querySelector('.bubble')?.textContent).toBe('All checks passed');
});
it('also shows saved pictures in the conversation for a journey step', async () => {
  const state = createDemoState(1_000_000);
  await act(async () => root.render(<StepConversation taskId="guest-checkout" find={lookup(state)} now={state.now} lines={[
    { id: 'report', at: 100, from: 'agent', roleId: 'builder', text: 'Checked this step', images: [{ id: 'step-picture', caption: 'The page checked in this step' }] },
  ]} />));
  expect(image).toHaveBeenCalledWith('guest-checkout', 'step-picture');
  expect(host.querySelector('figure')?.closest('.msg')?.textContent).toContain('Checked this step');
  expect(host.querySelector('img')?.alt).toBe('The page checked in this step');
});
it('loads a selected step’s pictures in its Conversation tab, keeping the Timeline separate', async () => {
  const state = createDemoState(1_000_000);
  const original = state.tasks.find((task) => task.id === 'pricing-refresh')!;
  const builder = original.journey!.find((step) => step.roleId === 'builder')!;
  const task = { ...original, session: [
    { id: 'builder-picture-report', at: builder.startedAt!, from: 'agent' as const, roleId: 'builder', step: builder.id, text: 'The builder checked the page', images: [{ id: 'chosen-picture', caption: 'The page after the change' }] },
  ] };
  await act(async () => root.render(<Journey task={task} state={state} find={lookup(state)} onReadSession={() => {}} onPlan={() => {}} />));
  const step = host.querySelector<HTMLElement>(`li[data-step-id="${builder.id}"]`)!;
  await act(async () => step.focus());
  await act(async () => step.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  const details = host.querySelector('.journey-details')!;
  await act(async () => details.querySelector<HTMLButtonElement>('[data-journey-tab="timeline"]')!.click());
  expect(host.querySelector('.step-conversation')).toBeNull();
  expect(image).not.toHaveBeenCalled();
  await act(async () => details.querySelector<HTMLButtonElement>('[data-journey-tab="conversation"]')!.click());
  expect(image).toHaveBeenCalledWith(task.id, 'chosen-picture');
  expect(details.querySelector('figure')?.closest('.msg')?.textContent).toContain('The builder checked the page');
  expect(details.querySelector('figcaption')?.textContent).toBe('The page after the change');
});
it('keeps the caption and report visible when a saved picture cannot load', async () => {
  image.mockRejectedValue(new Error('missing'));
  await render([{ id: 'report', at: 100, from: 'agent', roleId: 'tester', text: 'Checked it', images: [{ id: 'missing', caption: 'The tested page' }] }]);
  expect(host.querySelector('figure')?.textContent).toContain('This picture could not be loaded.');
  expect(host.querySelector('figcaption')?.textContent).toBe('The tested page');
});
