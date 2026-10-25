import { expect, it } from "bun:test";
import { conventions } from "../../quality/conventions.js";

const file = "packages/platform/test/contracts/processes/environment.test.ts";
const errors = (source: string) => conventions(new Map([[file, source]]));

it("rejects worker environment writes alongside concurrent native tests, including renamed test functions and computed keys", () => {
  for (const declaration of [
    `import { it } from "bun:test"; it.concurrent("parallel", () => {});`,
    `import { describe as group } from "bun:test"; group.concurrent("parallel", () => {});`,
    `import { test as check } from "bun:test"; check.each([1])["concurrent"]("parallel", () => {});`,
    `import * as testing from "bun:test"; testing.it.concurrent("parallel", () => {});`,
  ]) for (const mutation of [
    `process.env.PATH = "private";`,
    `process.env["TMPDIR"] = "private";`,
    `delete globalThis.process.env.TMP;`,
    `process["env"].COUNT++;`,
    `process.env = {};`,
    `Object.assign(process.env, { PATH: "private" });`,
    `Reflect.set(process.env, "PATH", "private");`,
    `Object.defineProperty(process.env, "PATH", { value: "private" });`,
    `(process.env as Record<string, string>).PATH = "private";`,
  ]) expect(errors(declaration + mutation)).toEqual([expect.stringContaining("concurrent tests cannot change process.env")]);
});

it("accepts serial native environment contracts and explicit per-command environment data", () => {
  expect(errors(`import { it } from "bun:test"; it("serial", () => { process.env.PATH = "private"; });`)).toEqual([]);
  expect(errors(`import { it } from "bun:test"; it.concurrent("parallel", () => {
    const env = { ...process.env, PATH: "private" }; env.PATH = "another private path";
  });`)).toEqual([]);
});

it("does not mistake read access, prose or a child program's code for worker mutation", () => {
  expect(errors(`import { it } from "bun:test"; it.concurrent("parallel", () => {
    const path = process.env.PATH;
    const script = "process.env.PATH = 'private';";
    // delete process.env.PATH;
  });`)).toEqual([]);
});

it("recognizes wrapped and optional concurrent registrations on the actual imported test APIs", () => {
  for (const declaration of [
    `import { it as check } from "bun:test"; (check as typeof check).concurrent("parallel", () => {});`,
    `import { test as check } from "vitest"; (check satisfies typeof check).concurrent("parallel", () => {});`,
    `import * as testing from "bun:test"; (testing as typeof testing).it.concurrent("parallel", () => {});`,
    `import { it } from "bun:test"; it?.concurrent("parallel", () => {});`,
    `import { it } from "bun:test"; it.concurrent?.("parallel", () => {});`,
    `import { it } from "bun:test"; it.concurrent.each([1])("parallel", () => {});`,
    `import { it } from "bun:test"; it["concurrent" as const]("parallel", () => {});`,
    `import { describe } from "bun:test"; describe.skipIf(false).concurrent("parallel", () => {});`,
  ]) expect(errors(declaration + `process.env.PATH = "private";`)).toEqual([expect.stringContaining("concurrent tests cannot change process.env")]);
});

it("recognizes optional Object and Reflect mutators with wrapped callees and environment targets", () => {
  for (const mutation of [
    `Object.assign?.(process.env, { PATH: "private" });`,
    `Object?.defineProperty(process.env, "PATH", { value: "private" });`,
    `Object.defineProperties?.((process.env as Record<string, string>), { PATH: { value: "private" } });`,
    `Reflect.set?.(process.env, "PATH", "private");`,
    `Reflect?.deleteProperty(process.env, "PATH");`,
    `(Reflect.defineProperty as typeof Reflect.defineProperty)?.(globalThis.process.env, "PATH", { value: "private" });`,
    `globalThis.Object.assign?.(process.env, { PATH: "private" });`,
    `Object["assign" as const]?.(process["env" as const], { PATH: "private" });`,
  ]) expect(errors(`import { it } from "bun:test"; it.concurrent("parallel", () => { ${mutation} });`)).toEqual([expect.stringContaining("concurrent tests cannot change process.env")]);
});

it("does not turn an API reference or unused test builder into concurrent cases", () => {
  for (const reference of [
    `const parallel = it.concurrent;`,
    `const parallel = (it as typeof it).concurrent;`,
    `const parallel = it.concurrent.each([1]);`,
    `const parallel = it.skipIf(false).concurrent;`,
    `const parallel = testing.it.concurrent;`,
  ]) expect(errors(`import { it } from "bun:test"; import * as testing from "bun:test"; ${reference}
    it("serial", () => { process.env.PATH = "private"; });`)).toEqual([]);
});

it("keeps private shadowed process and mutator objects out of the global environment rule", () => {
  for (const body of [
    `const process = { env: { PATH: "private" } }; process.env.PATH = "changed";`,
    `function helper(process: { env: Record<string, string> }) { process.env.PATH = "private"; }`,
    `try { throw {}; } catch (process) { (process as any).env.PATH = "private"; }`,
    `const Object = { assign(target: unknown, source: unknown) { return { target, source }; } }; Object.assign(process.env, { PATH: "private" });`,
    `const Reflect = { set(target: unknown, key: string, value: unknown) { return { target, key, value }; } }; Reflect.set(process.env, "PATH", "private");`,
    `const globalThis = { process: { env: { PATH: "private" } } }; globalThis.process.env.PATH = "changed";`,
  ]) expect(errors(`import { it } from "bun:test"; it.concurrent("parallel", () => { ${body} });`)).toEqual([]);
});

it("does not let a shadow in one scope hide the real global write in another", () => {
  for (const shadow of [
    `function privateProcess(process: any) { process.env.PATH = "private"; }`,
    `function privateObject(Object: any) { Object.assign(process.env, { PATH: "private" }); }`,
    `function privateReflect(Reflect: any) { Reflect.set(process.env, "PATH", "private"); }`,
    `class Private { static { const process = { env: { PATH: "private" } }; process.env.PATH = "private"; } }`,
    `namespace Private { const process = { env: { PATH: "private" } }; process.env.PATH = "private"; }`,
  ]) expect(errors(`import { it } from "bun:test"; ${shadow}
    it.concurrent("parallel", () => { process.env.PATH = "worker"; });`)).toEqual([expect.stringContaining("concurrent tests cannot change process.env")]);
  expect(errors(`import { it } from "bun:test"; it.concurrent("parallel", (process: any) => {
    globalThis.process.env.PATH = "worker";
  });`)).toEqual([expect.stringContaining("concurrent tests cannot change process.env")]);
});

it("does not mistake shadowed test function or namespace parameters for registrations", () => {
  expect(errors(`import { it } from "bun:test"; function helper(it: any) {
    it.concurrent("private callback", () => { process.env.PATH = "private"; });
  } it("serial", () => {});`)).toEqual([]);
  expect(errors(`import * as testing from "bun:test"; function helper(testing: any) {
    testing.it.concurrent("private callback", () => { process.env.PATH = "private"; });
  } testing.it("serial", () => {});`)).toEqual([]);
});
