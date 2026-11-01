

import { stateFixture } from "../../fixtures/state";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseCommand, type ProductCheck, type State } from "@petrina/core";
import { AddProductDialog } from "../../../src/components/AddProduct";
import { ProductEditor } from "../../../src/components/ProductSettings";

let currentSimState: State = stateFixture(1_000_000);

const commands = vi.hoisted(() => ({
  getState: vi.fn(() => currentSimState),
  addProduct: vi.fn(),
  pickFolder: vi.fn(),
  updateProduct: vi.fn(),
  removeProduct: vi.fn(),
  setProductChecks: vi.fn(),
  discoverProductChecks: vi.fn(),
  setProductCheckSetup: vi.fn(),
  setProductRemoteChecks: vi.fn(),
}));

vi.mock("../../../src/engine", () => ({
  sim: commands,
  useSim: () => currentSimState,
  useEngineStatus: () => ({ link: "live" }),
  failureText: (failure: unknown) => (failure instanceof Error ? failure.message : String(failure)),
}));

let host: HTMLDivElement, root: Root;

const closed = vi.fn(), removed = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  currentSimState = stateFixture(1_000_000);
  commands.getState.mockImplementation(() => currentSimState);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

async function mount(checks: readonly ProductCheck[] = [], checksBy?: "finder" | "coordinator") { const state = { ...stateFixture(1_000_000), tasks: [] }; await act(async () => root.render(<ProductEditor product={{ ...state.products[0]!, checks, ...(checksBy ? { checksBy } : {}) }} state={state} onClose={closed} onRemoved={removed} />)); }

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
  await edit(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Name for check 1"]')!, "Tests");
  await edit(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Command for Tests"]')!, "bun test");
  await click("Save", host.querySelector(".editor-footer")!);
  expect(commands.updateProduct).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Save or cancel your check edits first.");
  await escape(); expect(closed).not.toHaveBeenCalled(); await click("Keep editing");
  let finish!: () => void;
  commands.setProductChecks.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  await click("Save checks"); await escape();
  expect([...host.querySelectorAll<HTMLTextAreaElement | HTMLButtonElement>(".product-check-row textarea, .product-check-row button")].every(field => field.disabled)).toBe(true);
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

it("edits and saves check names and literal argv without decoding display escapes or splitting rows", async () => {
  const checks = [
    { name: "Owner's: checks\nsecond line", argv: [String.raw`C:\Users\O'Neil\Program Files\tool.exe`, "", `both 'single' and "double"`, "line one\nline two", String.raw`literal\n`, "&&"] },
    { name: "Second: check", argv: ["program", "two words"] },
  ];
  await mount(checks, "coordinator"); await click("Edit checks");
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Name for check 1"]')!.value).toBe(checks[0]!.name);
  for (const label of host.querySelectorAll<HTMLLabelElement>(".product-check-row label")) expect(document.getElementById(label.htmlFor)).toBeTruthy();
  await click("Save checks");
  const first = commands.setProductChecks.mock.calls[0]![1] as { name: string; command: string }[];
  expect(first.map(check => ({ name: check.name, argv: parseCommand(check.command) }))).toEqual(checks);
  expect(commands.setProductCheckSetup).not.toHaveBeenCalled(); expect(commands.updateProduct).not.toHaveBeenCalled();
  await click("Edit checks");
  await edit(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Name for check 1"]')!, "Renamed: check");
  await click("Save checks");
  const changed = commands.setProductChecks.mock.calls[1]![1] as { name: string; command: string }[];
  expect(changed.map(check => ({ name: check.name, argv: parseCommand(check.command) }))).toEqual([{ ...checks[0]!, name: "Renamed: check" }, checks[1]!]);
});

it("keeps invalid and rejected check drafts editable, and preserves discovery and cancel actions", async () => {
  await mount([{ name: "Tests", argv: ["program", "--check"] }], "finder"); await click("Edit checks");
  await edit(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Command for Tests"]')!, 'program "unfinished');
  await click("Save checks");
  expect(host.textContent).toContain("Close the quotation mark"); expect(commands.setProductChecks).not.toHaveBeenCalled();
  await edit(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Command for Tests"]')!, "program --changed");
  commands.setProductChecks.mockRejectedValueOnce(new Error("Could not save these checks.")); await click("Save checks");
  expect(host.textContent).toContain("Could not save these checks.");
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Command for Tests"]')!.value).toBe("program --changed");
  await click("Cancel", host.querySelector(".product-check-rows")!.parentElement!);
  await click("Find again"); expect(commands.setProductChecks).toHaveBeenLastCalledWith("shop", null);
});

it("adds and removes independent check rows while keeping the save blocked until fields are valid", async () => {
  await mount(); await click("Set checks by hand"); await click("Add check"); await click("Save checks");
  expect(host.querySelectorAll('[aria-invalid="true"]')).toHaveLength(4); expect(commands.setProductChecks).not.toHaveBeenCalled();
  const rows = host.querySelectorAll<HTMLElement>(".product-check-row");
  await edit(rows[1]!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Name for check 2"]')!, "Survives");
  await edit(rows[1]!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Command for Survives"]')!, "program --check");
  await click("Remove", rows[0]!); await click("Save checks");
  expect(commands.setProductChecks).toHaveBeenCalledWith("shop", [{ name: "Survives", command: "program --check" }]);
});

it("edits, validates, and saves plain-language GitHub check names while guarding unsaved drafts", async () => {
  await mount();
  await click("Add GitHub checks");
  const input = () => host.querySelectorAll<HTMLInputElement>('input[placeholder="Check name as shown on GitHub"]');
  await edit(input()[0]!, "Tests");
  await click("Save", host.querySelector(".editor-footer")!);
  expect(commands.updateProduct).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Save or cancel your GitHub check edits first.");

  await click("Add GitHub check");
  await edit(input()[1]!, "Tests");
  await click("Save GitHub checks");
  expect(commands.setProductRemoteChecks).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Use each GitHub check name only once.");

  await edit(input()[1]!, "  Linux validation  ");
  await click("Save GitHub checks");
  expect(commands.setProductRemoteChecks).toHaveBeenCalledWith("shop", ["Tests", "Linux validation"]);
});

it("queues single-step check discovery from Product settings and shows live status while active", async () => {
  const base = stateFixture(1_000_000);
  await act(async () =>
    root.render(
      <ProductEditor
        product={{ ...base.products[0]!, checks: [], checksBy: undefined }}
        state={{ ...base, tasks: [] }}
        onClose={closed}
        onRemoved={removed}
      />,
    ),
  );
  expect(host.textContent).toContain("choose Find checks now");
  await click("Find checks now");
  expect(commands.discoverProductChecks).toHaveBeenCalledWith("shop");

  const discoveryTask = {
    ...base.tasks[0]!,
    id: "discover-shop",
    productId: "shop",
    state: "running" as const,
    plan: {
      rationale: "Run Check finder directly as a single-step task.",
      plannerProfileId: "opus-high",
      stages: [{ id: "discover-shop:direct", title: "Find automated checks", kind: "do" as const, roleId: "check-finder", profileIds: ["opus-high"] }],
    },
  };
  const activeState = { ...base, tasks: [discoveryTask] };
  await act(async () =>
    root.render(<ProductEditor product={activeState.products[0]!} state={activeState} onClose={closed} onRemoved={removed} />),
  );
  expect(host.textContent).toContain("The Check finder is working them out now.");
  const findingBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Finding checks…")!;
  expect(findingBtn.disabled).toBe(true);
});

it("queues check discovery by default when adding a new product unless unchecked or already registered", async () => {
  const added = vi.fn();
  commands.addProduct.mockResolvedValueOnce("new-repo");
  await act(async () => root.render(<AddProductDialog onClose={closed} onAdded={added} />));
  const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(checkbox.checked).toBe(true);
  await edit(host.querySelector<HTMLInputElement>('input[aria-label="Folder of the local clone"]')!, "~/code/new-repo");
  await click("Add product");
  expect(commands.addProduct).toHaveBeenCalledWith("~/code/new-repo", "New Repo");
  expect(commands.discoverProductChecks).toHaveBeenCalledWith("new-repo");

  // Re-adding an already registered product does not queue duplicate check discovery.
  await act(async () => root.render(<AddProductDialog key="existing" onClose={closed} onAdded={added} />));
  commands.discoverProductChecks.mockClear();
  commands.addProduct.mockResolvedValueOnce("shop");
  await edit(host.querySelector<HTMLInputElement>('input[aria-label="Folder of the local clone"]')!, "~/code/shop");
  await click("Add product");
  expect(commands.discoverProductChecks).not.toHaveBeenCalled();
});
