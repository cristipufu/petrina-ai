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
import { type SessionLine } from "@petrina/core";
import { Session, StepConversation } from '../../../src/components/Session';
import { lookup } from '../../../src/lib';

const { image, previewImage } = vi.hoisted(() => ({ image: vi.fn(), previewImage: vi.fn() }));

vi.mock('../../../src/engine', () => ({ mode: 'demo', desktop: false, sim: { image, previewImage, synced: () => true }, useUnsent: () => [], useEngineStatus: () => ({ link: 'live' }), failureText: (reason: Error) => reason.message }));

let host: HTMLDivElement;

let root: Root;

let observer: IntersectionObserverCallback;

async function visible(...values: boolean[]) {
  await act(async () => observer((values.length ? values : [true]).map((value) => ({ isIntersecting: value } as IntersectionObserverEntry)), {} as IntersectionObserver));
}

const revoked = vi.fn();

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { observer = callback; }
    observe() {}
    disconnect() {}
  });
  image.mockResolvedValue(new Blob(['picture'], { type: 'image/png' }));
  previewImage.mockResolvedValue({ mime: 'image/png', data: 'AQID' });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:checked-page');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoked);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});

afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); image.mockReset(); previewImage.mockReset(); revoked.mockReset(); });

async function render(session: SessionLine[], finished = false) {
  const state = oneTaskFixture(1_000_000);
  const task = { ...state.tasks[0]!, id: 'guest-checkout', session, state: finished ? 'done' as const : 'running' as const };
  await act(async () => root.render(<Session.Log task={task} state={state} find={lookup(state)} scroller={{ current: host }} onTab={() => {}} />));
}

it('loads a picture separately beside its originating report, keeps the caption, and releases it on exit', async () => {
  await render([
    { id: 'build-report', at: 100, from: 'agent', roleId: 'builder', text: 'Checked the page', images: [{ id: 'picture-1', caption: 'The completed page check' }] },
    { id: 'review-report', at: 200, from: 'agent', roleId: 'code-reviewer', text: 'Review passed' },
  ]);
  expect(image).not.toHaveBeenCalled();
  await visible();
  expect(image).toHaveBeenCalledWith('guest-checkout', 'picture-1');
  const picture = host.querySelector('.message-image')!;
  expect(picture.closest('.msg')?.textContent).toContain('Builder');
  expect(picture.closest('.msg')?.textContent).toContain('Checked the page');
  expect(picture.querySelector('.message-image-caption')?.textContent).toBe('The completed page check');
  expect(picture.querySelector('img')?.alt).toBe('The completed page check screenshot');
  expect(host.querySelectorAll('.message-image')).toHaveLength(1);
  await render([]);
  expect(revoked).toHaveBeenCalledWith('blob:checked-page');
});

it('keeps reports without pictures as text and fetches nothing', async () => {
  await render([{ id: 'plain', at: 100, from: 'agent', roleId: 'builder', text: 'All checks passed' }]);
  expect(host.querySelector('.message-image')).toBeNull();
  expect(image).not.toHaveBeenCalled();
  expect(host.querySelector('.bubble')?.textContent).toBe('All checks passed');
});

for (const view of ['session', 'step'])
it(`keeps saved pictures and product-specific screenshot previews together in the ${view} conversation`, async () => {
  vi.stubGlobal('IntersectionObserver', undefined);
  const state = oneTaskFixture(1_000_000);
  const product = state.products[1]!;
  const line: SessionLine = { id: 'product-report', at: 100, from: 'agent', roleId: 'builder', productId: product.id, text: 'Checked this product. [Preview](screenshots/page.png)', images: [{ id: 'saved-picture', caption: `${product.name} after the change` }] };
  const task = { ...state.tasks[0]!, state: 'running' as const, session: [line] };
  await act(async () => root.render(view === 'session'
    ? <Session.Log task={task} state={state} find={lookup(state)} scroller={{ current: host }} onTab={() => {}} />
    : <StepConversation taskId={task.id} find={lookup(state)} now={state.now} lines={[line]} />));
  expect(previewImage).toHaveBeenCalledWith(task.id, 'screenshots/page.png', product.id);
  expect(image).toHaveBeenCalledWith(task.id, 'saved-picture');
  expect(host.querySelector<HTMLImageElement>('.message-image img')?.alt).toBe('Preview screenshot');
  expect(host.textContent).toContain(`${product.name} after the change`);
});

it('also shows saved pictures in the conversation for a journey step', async () => {
  const state = oneTaskFixture(1_000_000);
  await act(async () => root.render(<StepConversation taskId="guest-checkout" find={lookup(state)} now={state.now} lines={[
    { id: 'report', at: 100, from: 'agent', roleId: 'builder', text: 'Checked this step', images: [{ id: 'step-picture', caption: 'The page checked in this step' }] },
  ]} />));
  await visible();
  expect(image).toHaveBeenCalledWith('guest-checkout', 'step-picture');
  expect(host.querySelector('.message-image')?.closest('.msg')?.textContent).toContain('Checked this step');
  expect(host.querySelector('img')?.alt).toBe('The page checked in this step screenshot');
});

it('keeps the caption and report visible when a saved picture cannot load', async () => {
  image.mockRejectedValue(new Error('missing'));
  await render([{ id: 'report', at: 100, from: 'agent', roleId: 'tester', text: 'Checked it', images: [{ id: 'missing', caption: 'The tested page' }] }]);
  await visible();
  expect(host.querySelector('.message-image')?.textContent).toContain('missing');
  expect(host.querySelector('.message-image')?.textContent).toContain('The tested page');
});

it('releases report pictures away from the viewport and enlarges them in place', async () => {
  const session: SessionLine[] = [{ id: 'report', at: 100, from: 'agent', roleId: 'tester', text: 'Checked it', images: [{ id: 'picture', caption: 'The tested page' }] }];
  await render(session);
  expect(image).not.toHaveBeenCalled();
  await visible();
  const open = host.querySelector<HTMLButtonElement>('.message-image-open')!;
  await act(async () => { open.focus(); open.click(); });
  expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe('blob:checked-page');
  await visible(true, false);
  expect(revoked).not.toHaveBeenCalled();
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(revoked).toHaveBeenCalledTimes(1);
  expect(host.querySelector('img')).toBeNull();
});

it('finishing a task closes its picture and drops late responses without creating an image URL', async () => {
  const session: SessionLine[] = [{ id: 'report', at: 100, from: 'agent', roleId: 'tester', text: 'Checked it', images: [{ id: 'picture', caption: 'The tested page' }] }];
  let finish!: (value: Blob) => void;
  image.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  await render(session); await visible();
  await render(session, true);
  await act(async () => finish(new Blob(['late picture'])));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(host.textContent).toContain('The tested page');
  expect(host.textContent).toContain('Preview unavailable after the task finishes.');
  image.mockClear();
  await render(session, true);
  expect(image).not.toHaveBeenCalled();
});
