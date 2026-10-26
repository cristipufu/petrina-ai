

import { stateFixture } from "../../fixtures/state";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProductEditor } from "../../../src/components/ProductSettings";

const commands = vi.hoisted(() => ({ updateProduct: vi.fn(), removeProduct: vi.fn(), setProductChecks: vi.fn(), setProductCheckSetup: vi.fn() }));

vi.mock("../../../src/engine", () => ({ sim: commands, useEngineStatus: () => ({ link: "live" }), failureText: (failure: unknown) => failure instanceof Error ? failure.message : String(failure) }));

let host: HTMLDivElement, root: Root;

const closed = vi.fn(), removed = vi.fn();

beforeEach(() => { vi.resetAllMocks(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });

afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

async function mount() { const state = { ...stateFixture(1_000_000), tasks: [] }; await act(async () => root.render(<ProductEditor product={{ ...state.products[0]!, checks: [] }} state={state} onClose={closed} onRemoved={removed} />)); }

async function click(text: string, scope: ParentNode = host) { const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === text)!; await act(async () => button.click()); }

async function edit(input: HTMLInputElement | HTMLTextAreaElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }

const escape = async () => { await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))); };

it("keeps product edits until a side-panel dismissal is confirmed", async () => {
  await mount();
  await edit(host.querySelector<HTMLInputElement>("input")!, "New name");
  await escape();
  expect(host.querySelector('[role=alertdialog]')?.textContent).toContain("Discard product changes?");
  expect(closed).not.toHaveBeenCalled();
  await click("Keep editing");
  expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("New name");
  await act(async () => host.querySelector<HTMLElement>(".editor-scrim")!.click());
  await click("Discard changes");
  expect(closed).toHaveBeenCalledOnce();
});

it("does not drop separately edited checks when saving defaults or closing", async () => {
  await mount(); await click("Set checks by hand");
  await edit(host.querySelector("textarea")!, "Tests: bun test");
  await click("Save", host.querySelector(".editor-footer")!);
  expect(commands.updateProduct).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Save or cancel your check edits first.");
  await escape(); expect(closed).not.toHaveBeenCalled(); await click("Keep editing");
  let finish!: () => void;
  commands.setProductChecks.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  await click("Save checks"); await escape();
  await act(async () => host.querySelector<HTMLElement>(".editor-scrim")!.click());
  expect(closed).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(commands.setProductChecks).toHaveBeenCalledWith("shop", [{ name: "Tests", command: "bun test" }]);
  await click("Save", host.querySelector(".editor-footer")!);
  expect(commands.updateProduct).toHaveBeenCalledOnce(); expect(closed).toHaveBeenCalledOnce();
});

it("keeps removal confirmation open while saving and preserves errors for another try", async () => {
  await mount(); await click("Remove product");
  const dialog = host.querySelector('[role=alertdialog]')!;
  let fail!: (error: Error) => void;
  commands.removeProduct.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
  await click("Remove product", dialog); await escape();
  await act(async () => host.querySelector<HTMLElement>(".dialog-scrim")!.click());
  expect(host.querySelector('[role=alertdialog]')).toBe(dialog);
  expect([...dialog.querySelectorAll<HTMLButtonElement>("button")].every(button => button.disabled)).toBe(true);
  await act(async () => fail(new Error("Could not save the change")));
  expect(dialog.textContent).toContain("Could not save the change");
  expect(removed).not.toHaveBeenCalled();
  commands.removeProduct.mockResolvedValue(undefined);
  await click("Remove product", dialog);
  expect(removed).toHaveBeenCalledOnce();
});
