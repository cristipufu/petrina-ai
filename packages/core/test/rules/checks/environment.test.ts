import { expect, it } from "vitest";
import { isCheckExecutorFacts, isCheckOutputIdentity, sameCheckExecutorFacts, sameCheckOutputIdentity } from "../../../src/check-environment.js";
import type { CheckExecutorFacts, CheckOutputIdentity } from "../../../src/model.js";

const executor: CheckExecutorFacts = { version: 1, adapter: "local-product-checks", contract: 1, launchPolicy: 1,
  platform: "observed-platform", architecture: "observed-architecture", osRelease: "observed-release", runtime: { name: "observed-runtime", version: "1.0" } };
const empty = { algorithm: "sha256" as const, bytes: 0, digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" };
const abc = { algorithm: "sha256" as const, bytes: 3, digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
const identity: CheckOutputIdentity = { stdout: abc, stderr: empty };
const executorCopy = () => ({ ...executor, runtime: { ...executor.runtime } });
const identityCopy = () => ({ stdout: { ...identity.stdout }, stderr: { ...identity.stderr } });

it("compares actual executor facts independently of object key order, never boot or machine guesses", () => {
  const reordered = { runtime: { version: "1.0", name: "observed-runtime" }, osRelease: executor.osRelease,
    architecture: executor.architecture, platform: executor.platform, launchPolicy: 1, contract: 1, adapter: executor.adapter, version: 1 };
  expect(isCheckExecutorFacts(executor)).toBe(true);
  expect(sameCheckExecutorFacts(executor, reordered)).toBe(true);
  expect(sameCheckExecutorFacts(reordered, executor)).toBe(true);
  expect(sameCheckExecutorFacts(undefined, executor)).toBe(false);
  expect(sameCheckExecutorFacts(executor, undefined)).toBe(false);
  expect(sameCheckExecutorFacts(undefined, undefined)).toBe(false);
});

it.each([
  ["adapter", "another-adapter"], ["contract", 2], ["launchPolicy", 2], ["platform", "another-platform"],
  ["architecture", "another-architecture"], ["osRelease", "another-release"],
  ["runtime", { name: "another-runtime", version: "1.0" }], ["runtime", { name: "observed-runtime", version: "2.0" }],
] as const)("rejects a changed %s fact for reuse equality", (key, value) => {
  const changed = { ...executor, [key]: value };
  expect(isCheckExecutorFacts(changed)).toBe(true);
  expect(sameCheckExecutorFacts(executor, changed)).toBe(false);
});

it.each([undefined, null, false, [], {}, { ...executor, version: 2 }, { ...executor, version: "1" },
  { ...executor, contract: 0 }, { ...executor, launchPolicy: Number.NaN }, { ...executor, contract: Number.MAX_SAFE_INTEGER + 1 },
  { ...executor, platform: " " }, { ...executor, architecture: undefined }, { ...executor, osRelease: null },
  { ...executor, runtime: { name: "observed-runtime" } }, { ...executor, runtime: { ...executor.runtime, version: "" } },
  { ...executor, futureFact: "unknown relevance" }, { ...executor, runtime: { ...executor.runtime, futureFact: "unknown relevance" } },
].map(value => [value]))("does not recognize missing, malformed or unsupported executor facts (%#)", value => {
  expect(isCheckExecutorFacts(value)).toBe(false);
  expect(sameCheckExecutorFacts(value, value)).toBe(false);
});

it("rejects hidden or symbol fields instead of confusing enumerable counts with exact schema membership", () => {
  const swapped = executorCopy();
  Object.defineProperty(swapped, "version", { enumerable: false });
  Object.assign(swapped, { futureFact: true });
  const runtime = executorCopy();
  Object.defineProperty(runtime.runtime, "name", { enumerable: false });
  Object.assign(runtime.runtime, { futureFact: true });
  const hidden = executorCopy(), symbol = executorCopy(), missingFromJson = executorCopy();
  Object.defineProperty(hidden, "futureFact", { value: true });
  Object.defineProperty(symbol, Symbol("futureFact"), { value: true });
  Object.defineProperty(missingFromJson, "version", { enumerable: false });
  for (const value of [swapped, runtime, hidden, symbol, missingFromJson]) {
    expect(isCheckExecutorFacts(value)).toBe(false);
    expect(sameCheckExecutorFacts(value, value)).toBe(false);
  }
});

it("keeps every byte count and pipe identity separate, with genuine empty output valid", () => {
  expect(isCheckOutputIdentity(identity)).toBe(true);
  expect(isCheckOutputIdentity({ stdout: empty, stderr: empty })).toBe(true);
  expect(sameCheckOutputIdentity(identity, { stderr: { ...empty }, stdout: { ...abc } })).toBe(true);
  expect(sameCheckOutputIdentity(identity, { stdout: empty, stderr: abc })).toBe(false);
  expect(sameCheckOutputIdentity(identity, { stdout: { ...abc, bytes: 4 }, stderr: empty })).toBe(false);
  expect(sameCheckOutputIdentity(identity, { stdout: abc, stderr: abc })).toBe(false);
  expect(sameCheckOutputIdentity(undefined, undefined)).toBe(false);
});

it.each([undefined, null, [], {}, { stdout: abc }, { stderr: empty },
  { ...identity, futureFact: true }, { ...identity, stdout: { ...abc, futureFact: true } },
  { ...identity, stdout: { ...abc, algorithm: "sha512" } }, { ...identity, stdout: { ...abc, digest: abc.digest.toUpperCase() } },
  { ...identity, stdout: { ...abc, digest: "short" } }, { ...identity, stdout: { ...abc, bytes: -1 } },
  { ...identity, stdout: { ...abc, bytes: Number.POSITIVE_INFINITY } }, { ...identity, stdout: { ...abc, bytes: Number.MAX_SAFE_INTEGER + 1 } },
  { ...identity, stdout: { ...abc, bytes: 0 } }, { ...identity, stderr: null },
].map(value => [value]))("does not upgrade partial, malformed or unsupported output identity (%#)", value => {
  expect(isCheckOutputIdentity(value)).toBe(false);
  expect(sameCheckOutputIdentity(value, value)).toBe(false);
});

it("checks exact own enumerable pipe fields and rejects hidden or symbol future identities", () => {
  const swapped = identityCopy();
  Object.defineProperty(swapped.stdout, "algorithm", { enumerable: false });
  Object.assign(swapped.stdout, { futureFact: true });
  const hidden = identityCopy(), symbol = identityCopy();
  Object.defineProperty(hidden.stderr, "futureFact", { value: true });
  Object.defineProperty(symbol, Symbol("futureFact"), { value: true });
  for (const value of [swapped, hidden, symbol]) {
    expect(isCheckOutputIdentity(value)).toBe(false);
    expect(sameCheckOutputIdentity(value, value)).toBe(false);
  }
});
