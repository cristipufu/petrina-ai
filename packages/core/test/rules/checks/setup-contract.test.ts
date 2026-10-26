import { expect, it } from "vitest";
import { isCheckEnvironmentBinding, isCheckEnvironmentIdentity, normalizeCheckPrerequisites, sameCheckEnvironmentIdentity, sameCheckPrerequisites } from "../../../src/check-environment.js";
import { setupIdentity, setupRequirement } from "../../fixtures/check-setup.js";

it("normalizes a whole literal declaration without parsing, removing empty arguments or mutating its input", () => {
  const original = [{ id: " compiler ", name: " Compiler identity ", argv: ["a tool", "--value", "", "a b"] }];
  const result = normalizeCheckPrerequisites(original);
  expect(result).toEqual([{ id: "compiler", name: "Compiler identity", argv: ["a tool", "--value", "", "a b"] }]);
  expect(original[0]!.id).toBe(" compiler "); expect(result[0]!.argv).not.toBe(original[0]!.argv);
  expect(normalizeCheckPrerequisites([])).toEqual([]);
});

it.each([undefined, null, {}, [null], [{}], [{ ...setupRequirement, extra: true }], [{ ...setupRequirement, id: " " }],
  [{ ...setupRequirement, name: "x".repeat(41) }], [{ ...setupRequirement, argv: [] }], [{ ...setupRequirement, argv: [""] }],
  [{ ...setupRequirement, argv: ["tool", false] }], [{ ...setupRequirement, argv: ["tool", "x".repeat(500)] }],
  [setupRequirement, { ...setupRequirement, name: "Other name" }], [setupRequirement, { ...setupRequirement, id: "other" }],
  Array.from({ length: 13 }, (_, index) => ({ ...setupRequirement, id: String(index), name: String(index) })),
  new Array(1), [{ ...setupRequirement, argv: new Array(1) }],
].map(value => [value]))("rejects the complete malformed declaration before any mutation (%#)", value => {
  expect(() => normalizeCheckPrerequisites(value)).toThrow();
});

it("keeps declaration equality independent of object key order, but sensitive to ordered argument and requirement changes", () => {
  const reordered = { argv: [...setupRequirement.argv], name: setupRequirement.name, id: setupRequirement.id };
  expect(sameCheckPrerequisites([setupRequirement], [reordered])).toBe(true);
  expect(sameCheckPrerequisites([setupRequirement], [{ ...setupRequirement, argv: ["compiler", "", "--version"] }])).toBe(false);
  expect(sameCheckPrerequisites([setupRequirement], [{ ...setupRequirement, name: "Another name" }])).toBe(false);
  expect(sameCheckPrerequisites([setupRequirement], [])).toBe(false);
  const next = { id: "browser", name: "Browser identity", argv: ["browser", "--version"] };
  expect(sameCheckPrerequisites([setupRequirement, next], [next, setupRequirement])).toBe(false);
});

it("compares the durable environment independently of before/after provenance and key order", () => {
  const identity = setupIdentity(), binding = { ...identity, setupAttempts: { before: "old-before", after: "old-after" } };
  const later = { prerequisites: { kind: "none" as const }, executor: identity.executor, contract: identity.contract, version: 1 as const,
    setupAttempts: { after: "new-after", before: "new-before" } };
  expect(isCheckEnvironmentIdentity(identity)).toBe(true); expect(isCheckEnvironmentBinding(binding)).toBe(true);
  expect(sameCheckEnvironmentIdentity(binding, later)).toBe(true);
  expect(sameCheckEnvironmentIdentity(identity, binding)).toBe(true);
  expect(sameCheckEnvironmentIdentity(binding, { ...identity, executor: "d".repeat(64) })).toBe(false);
  expect(sameCheckEnvironmentIdentity(binding, { ...identity, contract: "d".repeat(64) })).toBe(false);
  expect(sameCheckEnvironmentIdentity(identity, setupIdentity(true))).toBe(false);
});

it.each([undefined, {}, { ...setupIdentity(), version: 2 }, { ...setupIdentity(), boot: "not an equality fact" },
  { ...setupIdentity(), executor: "short" }, { ...setupIdentity(), prerequisites: { kind: "none", observations: "c".repeat(64) } },
  { ...setupIdentity(true), prerequisites: { kind: "declared" } },
  { ...setupIdentity(), setupAttempts: { before: "same", after: "same" } },
  { ...setupIdentity(), setupAttempts: { before: "before", after: "" } },
].map(value => [value]))("does not give malformed or unsupported identities durable equality (%#)", value => {
  expect(sameCheckEnvironmentIdentity(value, value)).toBe(false);
});
