import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState, draftOf, MAINTENANCE_ROLES, occurrenceText, Simulator, type RoutineDraft } from "@petrina/core";
import { Routines } from "../src/components/Routines";
import { lookup } from "../src/lib";

let simulator: Simulator;
const status = { link: "live" };
vi.mock("../src/engine", () => ({
  useEngineStatus: () => status,
  sim: new Proxy({}, { get: (_, name) => (...args: unknown[]) => (simulator[name as keyof Simulator] as Function).apply(simulator, args) }),
}));
let root: Root, host: HTMLDivElement;
let product = "all";
const opened = vi.fn();
function Library() {
  const state = useSyncExternalStore(fn => simulator.subscribe(fn), () => simulator.getState());
  return <Routines state={state} find={lookup(state)} product={product} onOpen={opened} />;
}
const button = (name: string, scope: ParentNode = host) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find(b => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name)!;
const field = (name: string) => [...host.querySelectorAll<HTMLLabelElement>("label")].find(label => label.querySelector(".field-label")?.textContent === name)!.control as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
async function change(name: string, value: string) {
  await act(async () => {
    const control = field(name);
    const proto = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(control, value);
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
async function click(name: string, scope?: ParentNode) { await act(async () => button(name, scope).click()); }
beforeEach(async () => {
  status.link = "live"; product = "all"; opened.mockClear();
  const state = createDemoState(Date.parse("2026-01-01T00:00:00Z"));
  simulator = new Simulator({ ...state, tasks: [], inbox: [], pool: { ...state.pool, paused: true } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Library />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("Library routines", () => {
  it("previews stepped dates and queues the same matching occurrence", async () => {
    await click("Add a routine"); await change("Frequency", "cron");
    await change("Time zone", "UTC"); await change("Custom cron schedule", "0 0 */2 * *");
    const expected = ["2026-01-03T00:00Z", "2026-01-05T00:00Z", "2026-01-07T00:00Z"].map(Date.parse);
    expect([...host.querySelectorAll("ol li")].map(node => node.getAttribute("aria-label"))).toEqual(expected.map(at => occurrenceText(at, "UTC")));
    await click("Save routine");
    expect(simulator.getState().routines![0]!.nextAt).toBe(expected[0]);
    await act(async () => simulator.tick(Date.parse("2026-01-02T00:00Z")));
    expect(simulator.getState().tasks).toHaveLength(0);
    await act(async () => simulator.tick(expected[0]!));
    expect(simulator.getState().tasks[0]!.maintenance?.scheduledAt).toBe(expected[0]);
  });
  it("repairs an unavailable role with a future queue time and no false catch-up", async () => {
    let roleId = "";
    await act(async () => { roleId = simulator.addRole({ ...draftOf(MAINTENANCE_ROLES.at(-1)!), name: "Temporary finder" }); });
    await click("Add a routine"); await change("Maintenance role", roleId); await change("Time zone", "UTC"); await click("Save routine");
    await act(async () => { simulator.removeRole(roleId); simulator.tick(Date.parse("2026-01-10T12:00Z")); });
    expect(host.textContent).toContain("Needs attention");
    await click("Edit"); await change("Maintenance role", "maintenance-bug-finder"); await click("Save routine");
    expect(host.textContent).not.toContain("Needs attention");
    expect(simulator.getState().routines![0]!.nextAt).toBe(Date.parse("2026-01-11T09:00Z"));
    await act(async () => simulator.tick(Date.parse("2026-01-10T12:00Z")));
    expect(simulator.getState().tasks).toHaveLength(0); expect(host.querySelector(".routines-grid article")?.textContent).not.toContain("catch-up task");
  });
  it("creates and edits a weekly routine with a saved zone and three queue times", async () => {
    expect(host.textContent).toContain("No routines yet");
    await click("Add a routine");
    expect([...field("Maintenance role").querySelectorAll("option")].every(o => o.value.startsWith("maintenance-"))).toBe(true);
    await change("Maintenance role", "maintenance-bug-finder");
    await change("Frequency", "weekly");
    await change("Time zone", "America/New_York");
    const friday = [...host.querySelectorAll("label")].find(label => label.textContent === "Friday")!.control as HTMLInputElement;
    await act(async () => friday.click());
    expect(host.querySelectorAll("ol li")).toHaveLength(3);
    expect(host.textContent).toContain("read-only");
    await act(async () => host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true })));
    const saved = simulator.getState().routines![0]!;
    expect(saved.schedule).toEqual({ kind: "weekly", time: "09:00", weekdays: [1, 5] });
    expect(saved.zone).toBe("America/New_York"); expect(saved.name).toContain("Bug finder");
    expect(host.textContent).toContain("Codex · GPT-6.1 Sol · medium effort");
    expect(host.textContent).toContain("Next queue time");
    await click("Edit"); await change("Time zone", "Asia/Tokyo"); await click("Save routine");
    expect(simulator.getState().routines![0]!.nextAt).not.toBe(saved.nextAt);
    await click("Disable"); expect(host.textContent).toContain("Disabled");
    await click("Enable"); expect(simulator.getState().routines![0]!.enabled).toBe(true);
    await click("Remove"); await click("Remove routine", host.querySelector('[role="alertdialog"]')!);
    expect(simulator.getState().routines).toEqual([]);
  });

  it("announces custom schedule errors, preserves unsaved edits and returns focus", async () => {
    button("Add a routine").focus(); await click("Add a routine");
    await change("Frequency", "cron"); await change("Custom cron schedule", "0 0 31 2 *");
    await click("Save routine");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("no possible date");
    expect(simulator.getState().routines ?? []).toHaveLength(0);
    await change("Custom cron schedule", "0 0 29 2 *"); await change("Time zone", "Missing/Zone"); await click("Save routine");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("recognized time zone");
    await click("Cancel"); expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
    await click("Keep editing"); expect(field("Time zone").value).toBe("Missing/Zone");
    await click("Cancel"); await click("Discard changes");
    expect(document.activeElement).toBe(button("Add a routine"));
  });

  it("keeps scheduling explanations separate from task links and respects product and connection state", async () => {
    const state = simulator.getState();
    const draft: RoutineDraft = { name: "Bug search", productId: state.products[0]!.id, roleId: "maintenance-bug-finder", profileId: "sol-medium", focus: "Checkout", zone: "UTC", schedule: { kind: "daily", time: "09:00" }, enabled: true };
    await act(async () => simulator.saveRoutine(draft));
    const due = simulator.getState().routines![0]!.nextAt;
    await act(async () => simulator.tick(due));
    await act(async () => simulator.tick(due + 86_400_000));
    const latest = [...host.querySelectorAll("a")].find(a => a.textContent === "Latest queued run")!;
    expect(latest.textContent).not.toContain("Skipped"); expect(host.textContent).toContain("Skipped this occurrence");
    expect(host.textContent).toContain("pool is paused");
    await act(async () => latest.click()); expect(opened).toHaveBeenCalledWith(simulator.getState().routines![0]!.latestTaskId);
    product = state.products[1]!.id; await act(async () => root.render(<Library />));
    expect(host.textContent).toContain("No routines yet");
    status.link = "reconnecting"; await act(async () => root.render(<Library />));
    expect(button("Add a routine").disabled).toBe(true); expect(host.textContent).toContain("reconnect");
  });
});
