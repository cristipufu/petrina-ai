import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { removeFixtureRoot } from "../../../src/fixture-roots.js";
import { tempDir } from "../../../src/fixtures.js";
import { rejectionOf } from "../../../src/rejections.js";
import { setupWithCleanup } from "../../../src/setup-with-cleanup.js";
import { fixtureOperationControl } from "../../../src/fixture-operation-control.js";

async function withRoot(body: (root: string, restore: (effect: () => void) => void) => void | Promise<void>): Promise<void> {
  const root = tempDir("petrina-fixture-roots-"), restores: (() => void)[] = [];
  const cleanup = () => {
    const errors: unknown[] = [];
    for (const restore of restores.reverse()) { try { restore(); } catch (error) { errors.push(error); } }
    try { removeFixtureRoot(root); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Fixture-root control cleanup failed");
  };
  await setupWithCleanup(() => body(root, effect => restores.push(effect)), cleanup);
  await cleanup();
}

it("removes an actual nested private root and accepts an already absent root", async () => withRoot(root => {
  const nested = join(root, "nested");
  fs.mkdirSync(nested); fs.writeFileSync(join(nested, "record"), "private fixture data");
  removeFixtureRoot(root);
  expect(fs.existsSync(root)).toBe(false);
  removeFixtureRoot(root);
  expect(fs.existsSync(root)).toBe(false);
}));

it("retries transient EBUSY handle-rundown errors and preserves the cause if the lock persists", async () => {
  await withRoot((root, restore) => {
    const native = fs.rmSync, remove = spyOn(fs, "rmSync");
    restore(() => remove.mockRestore());
    let attempts = 0;
    remove.mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
      if (path === root && ++attempts <= 2) throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
      return Reflect.apply(native, fs, [path, ...args]);
    }) as typeof fs.rmSync);
    removeFixtureRoot(root);
    expect(attempts).toBe(3);
    expect(fs.existsSync(root)).toBe(false);
  });

  await withRoot(async (root, restore) => {
    const native = fs.rmSync, remove = spyOn(fs, "rmSync");
    restore(() => remove.mockRestore());
    const busy = Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
    let attempts = 0;
    remove.mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
      if (path === root) {
        attempts++;
        throw busy;
      }
      return Reflect.apply(native, fs, [path, ...args]);
    }) as typeof fs.rmSync);
    const f = fixtureOperationControl();
    f.effects.disposeEffect = () => removeFixtureRoot(root);
    const error = await rejectionOf(f.owner.close());
    expect(attempts).toBe(6);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Persistent EBUSY lost its error wrapper");
    expect(error.cause).toBe(busy);
    expect(fs.lstatSync(root).isDirectory()).toBe(true);
  });
});

for (const [label, failure] of [["Error", Object.assign(new Error("Removal denied"), { code: "EACCES" })], ["undefined", undefined]] as const) {
  it(`retains a failed owner's actual root and preserves the removal cause ${label}`, async () => withRoot(async (root, restore) => {
    const native = fs.rmSync, remove = spyOn(fs, "rmSync");
    restore(() => remove.mockRestore());
    remove.mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
      if (path === root) throw failure;
      return Reflect.apply(native, fs, [path, ...args]);
    }) as typeof fs.rmSync);
    const f = fixtureOperationControl();
    f.effects.disposeEffect = () => removeFixtureRoot(root);
    const closing = f.owner.close(), error = await rejectionOf(closing);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Removal failure lost its error wrapper");
    expect(Object.hasOwn(error, "cause")).toBe(true);
    expect(error.cause).toBe(failure);
    expect(f.owner.close()).toBe(closing);
    expect(await rejectionOf(f.owner.close())).toBe(error);
    expect(fs.lstatSync(root).isDirectory()).toBe(true);
    expect(f.effects.events).toEqual(["stop", "dispose"]);
  }));
}

it("refuses owner disposal when removal returns but the actual root still exists", async () => withRoot(async (root, restore) => {
  const native = fs.rmSync, remove = spyOn(fs, "rmSync");
  restore(() => remove.mockRestore());
  remove.mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
    if (path === root) return;
    return Reflect.apply(native, fs, [path, ...args]);
  }) as typeof fs.rmSync);
  const f = fixtureOperationControl();
  f.effects.disposeEffect = () => removeFixtureRoot(root);
  const error = await rejectionOf(f.owner.close());
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error("A remaining root authorized disposal");
  expect(error.message).toBe(`Fixture root remains after removal: ${root}`);
  expect(fs.lstatSync(root).isDirectory()).toBe(true);
}));

for (const [label, failure] of [["Error", Object.assign(new Error("Inspection denied"), { code: "EACCES" })], ["undefined", undefined]] as const) {
  it(`preserves an unknown post-removal inspection ${label} without authorizing owner disposal`, async () => withRoot(async (root, restore) => {
    const native = fs.lstatSync, inspect = spyOn(fs, "lstatSync");
    restore(() => inspect.mockRestore());
    inspect.mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
      if (path === root) throw failure;
      return Reflect.apply(native, fs, [path, ...args]);
    }) as typeof fs.lstatSync);
    const f = fixtureOperationControl();
    f.effects.disposeEffect = () => removeFixtureRoot(root);
    const closing = f.owner.close();
    expect(await rejectionOf(closing)).toBe(failure);
    expect(f.owner.close()).toBe(closing);
    expect(await rejectionOf(f.owner.close())).toBe(failure);
    // Removal really ran; its success alone is not authority for the failed absence observation.
    expect(fs.existsSync(root)).toBe(false);
  }));
}
