import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createDemoState, type State, type UsageRequest } from "@petrina/core";
import { useUsage } from "../src/usage";

const read = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/engine", () => ({ sim: { usage: read } }));
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; read.mockClear(); });
function View({ state, request }: { state: State; request?: UsageRequest }) { useUsage(request, state); return null; }

it("refreshes an open Analytics view once per minute while paused without work-log changes", async () => {
  const base = createDemoState(120_000);
  const state = { ...base, pool: { ...base.pool, paused: true } };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const render = async (now: number, request: UsageRequest = { view: "analytics", period: "7d" }) => act(async () => root!.render(<View state={{ ...state, now }} request={request} />));
  await render(state.now);
  expect(read).toHaveBeenCalledExactlyOnceWith({ view: "analytics", period: "7d" });
  await render(state.now + 15_000);
  expect(read).toHaveBeenCalledTimes(1);
  await render(state.now + 60_000);
  expect(read).toHaveBeenCalledTimes(2);
  await render(state.now + 120_000, { view: "today" });
  expect(read).toHaveBeenCalledTimes(3);
  await render(state.now + 180_000, { view: "today" });
  expect(read).toHaveBeenCalledTimes(3);
  await act(async () => root!.render(<View state={{ ...state, now: state.now + 240_000 }} />));
  expect(read).toHaveBeenCalledTimes(3);
});
