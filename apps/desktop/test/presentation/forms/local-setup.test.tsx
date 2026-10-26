import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CheckPrerequisite } from "@petrina/core";
import { ProductEditor } from "../../../src/components/ProductSettings";
import { stateFixture } from "../../fixtures/state";

const commands = vi.hoisted(() => ({ updateProduct: vi.fn(), removeProduct: vi.fn(), setProductChecks: vi.fn(), setProductCheckSetup: vi.fn(), live: true }));
vi.mock("../../../src/engine", () => ({ sim: commands, useEngineStatus: () => ({ link: commands.live ? "live" : "reconnecting" }), failureText: (failure: unknown) => failure instanceof Error ? failure.message : String(failure) }));
let host: HTMLDivElement, root: Root;
const closed = vi.fn(), removed = vi.fn();
beforeEach(() => { vi.resetAllMocks(); commands.live = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function mount(requirements?: readonly CheckPrerequisite[]) {
  const state = { ...stateFixture(1_000_000), tasks: [] };
  await act(async () => root.render(<ProductEditor product={{ ...state.products[0]!, checks: [], ...(requirements ? { checkSetup: { revision: "saved-revision", requirements } } : {}) }} state={state} onClose={closed} onRemoved={removed} />));
}
function button(text: string) { return [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === text)!; }
async function click(text: string) { await act(async () => button(text).click()); }
async function edit(input: HTMLInputElement | HTMLTextAreaElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
const escape = () => act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
const row = (index = 0) => host.querySelectorAll<HTMLElement>(".local-setup-row")[index]!;

it("saves literal argv and stable requirement ids, including quotes, backslashes, empty args and newlines", async () => {
  const argv = ["C:\\Tools\\My Compiler\\tool.exe", "--identify", "", `both 'single' and "double"`, "line one\nline two", "|", "&&"];
  await mount([{ id: "stable-id", name: "Compiler", argv }]); await click("Edit local setup");
  expect(host.textContent).toContain("Changes apply to unfinished work and require fresh verification.");
  await edit(row().querySelector("input")!, "Compiler version"); await click("Save local setup");
  expect(commands.setProductCheckSetup).toHaveBeenCalledExactlyOnceWith("shop", [{ id: "stable-id", name: "Compiler version", argv }]);
  expect(commands.setProductChecks).not.toHaveBeenCalled(); expect(commands.updateProduct).not.toHaveBeenCalled();
});

it("validates visible empty, repeated and unclosed fields before calling the setter", async () => {
  await mount(); await click("Add local setup"); await click("Add requirement"); await click("Save local setup");
  expect(host.textContent).toContain("Give this requirement a name."); expect(host.textContent).toContain("Enter a command");
  await edit(row().querySelector("input")!, "Compiler"); await edit(row().querySelector("textarea")!, 'compiler "unfinished'); await click("Save local setup");
  expect(host.textContent).toContain("Close the quotation mark"); expect(commands.setProductCheckSetup).not.toHaveBeenCalled();
  await edit(row().querySelector("textarea")!, "compiler --version"); await click("Add requirement");
  await edit(row(1).querySelector("input")!, "Compiler"); await edit(row(1).querySelector("textarea")!, "compiler --identity"); await click("Save local setup");
  expect(host.querySelectorAll('[aria-invalid="true"]')).toHaveLength(2); expect(host.textContent).toContain("Use a different name");
  expect(commands.setProductCheckSetup).not.toHaveBeenCalled();
});

it("keeps local edits in the product's existing discard and defaults-save flow", async () => {
  await mount(); await click("Add local setup"); await click("Add requirement"); await edit(row().querySelector("input")!, "Compiler");
  await click("Save"); expect(commands.updateProduct).not.toHaveBeenCalled(); expect(host.textContent).toContain("Save or cancel your local setup edits first.");
  await escape(); expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain("Discard product changes?");
  await click("Keep editing"); expect(row().querySelector<HTMLInputElement>("input")!.value).toBe("Compiler");
  await click("Cancel local setup"); await escape(); expect(closed).toHaveBeenCalledOnce(); expect(commands.setProductCheckSetup).not.toHaveBeenCalled();
});

it("keeps dismissal and other settings disabled while the actual save is pending", async () => {
  await mount([{ id: "compiler", name: "Compiler", argv: ["compiler", "--version"] }]); await click("Edit local setup");
  let finish!: () => void; commands.setProductCheckSetup.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  await click("Save local setup"); expect(host.querySelector(".editor-panel")?.getAttribute("aria-busy")).toBe("true");
  await escape(); await act(async () => host.querySelector<HTMLElement>(".editor-scrim")!.click());
  expect(closed).not.toHaveBeenCalled(); expect(button("Save").disabled).toBe(true);
  expect([...row().querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input, textarea, button")].every(field => field.disabled)).toBe(true);
  await act(async () => finish()); expect(host.querySelector(".editor-panel")?.hasAttribute("aria-busy")).toBe(false);
});

it("keeps a rejected save editable and retries with the same id", async () => {
  await mount(); await click("Add local setup"); await click("Add requirement"); await edit(row().querySelector("input")!, "Compiler"); await edit(row().querySelector("textarea")!, "compiler --version");
  commands.setProductCheckSetup.mockRejectedValueOnce(new Error("The setup could not be saved.")); await click("Save local setup");
  expect(host.textContent).toContain("The setup could not be saved."); expect(row().querySelector<HTMLInputElement>("input")?.value).toBe("Compiler");
  const first = commands.setProductCheckSetup.mock.calls[0]![1]; await click("Save local setup"); expect(commands.setProductCheckSetup.mock.calls[1]![1]).toEqual(first);
});

it("can remove all requirements and cannot save while disconnected", async () => {
  const requirements = [{ id: "compiler", name: "Compiler", argv: ["compiler", "--version"] }];
  await mount(requirements); await click("Edit local setup"); await click("Remove"); commands.live = false; await mount(requirements);
  expect(button("Save local setup").disabled).toBe(true); await click("Save local setup"); expect(commands.setProductCheckSetup).not.toHaveBeenCalled();
  commands.live = true; await mount(requirements); await click("Save local setup"); expect(commands.setProductCheckSetup).toHaveBeenCalledWith("shop", []);
});

it("labels each field and preserves surviving ids after removing a row", async () => {
  await mount([{ id: "first", name: "Compiler", argv: ["compiler", "--version"] }, { id: "second", name: "Browser", argv: ["browser", "--version"] }]); await click("Edit local setup");
  for (const label of host.querySelectorAll<HTMLLabelElement>(".local-setup-row label")) expect(document.getElementById(label.htmlFor)).toBeTruthy();
  await act(async () => row().querySelector<HTMLButtonElement>("button")!.click()); await click("Save local setup");
  expect(commands.setProductCheckSetup).toHaveBeenCalledWith("shop", [{ id: "second", name: "Browser", argv: ["browser", "--version"] }]);
});
