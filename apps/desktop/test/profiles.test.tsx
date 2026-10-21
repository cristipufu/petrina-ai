import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createDemoState, Simulator } from "@petrina/core";
import { Profiles } from "../src/components/Profiles";
let simulator: Simulator, host: HTMLDivElement, root: Root;
vi.mock("../src/engine", () => ({ failureText: (e: Error) => e.message, useEngineStatus: () => ({ link: "live" }), sim: new Proxy({}, { get: (_, name) => (...args: unknown[]) => (simulator[name as keyof Simulator] as Function).apply(simulator, args) }) }));
function View() { const state = useSyncExternalStore(fn => simulator.subscribe(fn), () => simulator.getState()); return <Profiles state={state} />; }
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name)!;
async function click(name: string) { await act(async () => button(name).click()); }
async function choose(label: string, value: string) {
  await act(async () => { const select = [...host.querySelectorAll("label")].find(node => node.querySelector(".field-label")?.textContent === label)!.control as HTMLSelectElement; select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
}
beforeEach(async () => { const state = createDemoState(1_000_000_000); simulator = new Simulator({ ...state, tasks: [], inbox: [], pool: { ...state.pool, paused: true } }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root.render(<View />)); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it("groups model identities, shows tool icons and labels effort choices", () => {
  expect([...host.querySelectorAll("h3")].map(node => node.textContent).filter(name => name === "GPT-6.1 Sol")).toHaveLength(1);
  expect([...host.querySelectorAll("h3")].map(node => node.textContent).filter(name => name === "GPT-6 Astra")).toHaveLength(1);
  expect(host.querySelectorAll(".profile-card .tool-icon")).toHaveLength(host.querySelectorAll(".profile-card").length);
  expect(button("Edit Codex GPT-6.1 Sol, high effort")).toBeTruthy();
});
it("creates a supported profile, edits it without rewriting its old definition, and removes it", async () => {
  await click("New profile"); await choose("Effort", "medium"); await click("Save profile");
  const added = simulator.getState().profiles.find(p => p.toolId === "claude-code" && p.modelId === "opus" && p.effort === "medium")!;
  expect(added).toBeTruthy();
  await click("Edit Claude Code Opus 5.5, medium effort"); await choose("Model", "fable"); await click("Save profile");
  expect(simulator.getState().retiredProfiles).toContainEqual(added);
  await click("Edit Claude Code Fable 5.1, medium effort"); await click("Remove profile");
  const confirm = host.querySelector(".dialog")!;
  await act(async () => [...confirm.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Remove profile")!.click());
  expect(simulator.getState().profiles.some(p => p.modelId === "fable" && p.effort === "medium")).toBe(false);
});
it("closes an untouched editor without a false discard prompt and refuses duplicate configurations", async () => {
  await click("New profile"); await click("Cancel"); expect(host.querySelector('[role="dialog"]')).toBeNull();
  await click("New profile"); await click("Save profile"); expect(host.querySelector('[role="alert"]')?.textContent).toContain("already exists");
});
it("reads default choices once and refreshes only the explicit request", async () => {
  const read = vi.spyOn(simulator, "profileChoices");
  await click("New profile");
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenLastCalledWith("claude-code", undefined, false);
  await click("Refresh choices");
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenLastCalledWith("claude-code", "opus", true);
  await choose("Model", "fable");
  expect(read).toHaveBeenCalledTimes(3);
  expect(read).toHaveBeenLastCalledWith("claude-code", "fable", false);
  await choose("Tool", "codex");
  expect(read).toHaveBeenCalledTimes(4);
  expect(read).toHaveBeenLastCalledWith("codex", undefined, false);
  await choose("Model", "gpt-6-astra");
  expect(read).toHaveBeenCalledTimes(5);
  expect(read).toHaveBeenLastCalledWith("codex", "gpt-6-astra", false);
});
it("ignores a slower previous tool's choices after changing tools", async () => {
  const original = simulator.profileChoices.bind(simulator);
  let finish!: (result: Awaited<ReturnType<typeof original>>) => void;
  vi.spyOn(simulator, "profileChoices").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await click("New profile");
  await choose("Tool", "codex");
  await act(async () => finish(await original("claude-code")));
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!.value).toBe("gpt-6.1-sol");
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="Tool"]')!.value).toBe("codex");
});
