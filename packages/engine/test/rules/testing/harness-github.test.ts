import { expect, it } from "bun:test";
import { githubSettlement, type GitHubStart, type GitHubLink } from "../../fixtures/harness-github-state.js";
import type { LeasedProgramRecord } from "@petrina/test-support/leased-program-records";
import type { ChildState } from "@petrina/platform/process-tree";

const started: GitHubStart = { id: "launch", state: "started", pid: 23 };
const ended: LeasedProgramRecord = { id: "actor", pid: 23, kind: "github", state: "ended", code: 0 };
const link: GitHubLink = { attempt: started.id, actor: ended.id, pid: 23 };
const observed = (state: ChildState) => new Map([[23, state]]);

it("permits no-helper disposal only when there was no native start intent", () => {
  expect(githubSettlement([], [], [], new Map(), new Set()).kind).toBe("settled");
  expect(githubSettlement([started], [], [], observed("running"), new Set()).kind).toBe("pending");
});

for (const state of ["entered", "start-unknown", "exit-unknown"] as const)
it(`retains an unresolved ${state} native start even without actor records`, () => {
  expect(githubSettlement([{ ...started, state }], [], [], new Map(), new Set()).kind).toBe("uncertain");
});

it("does not infer native birth or exit from missing identity facts", () => {
  expect(githubSettlement([{ id: "launch", state: "started" }], [], [], new Map(), new Set()).kind).toBe("uncertain");
  expect(githubSettlement([{ ...started, state: "exited" }], [ended], [link], observed("ended"), new Set()).kind).toBe("uncertain");
});

it("waits for actor/link publication in either order without accepting a partial snapshot", () => {
  expect(githubSettlement([started], [ended], [], observed("ended"), new Set()).kind).toBe("pending");
  expect(githubSettlement([started], [], [link], observed("ended"), new Set()).kind).toBe("pending");
});

it("requires exact native attempt, actor and PID correlation", () => {
  expect(githubSettlement([], [ended], [link], observed("ended"), new Set()).kind).toBe("uncertain");
  expect(githubSettlement([started], [ended], [{ ...link, attempt: "another" }], observed("ended"), new Set()).kind).toBe("uncertain");
  expect(githubSettlement([started], [ended], [{ ...link, pid: 24 }], observed("ended"), new Set()).kind).toBe("pending");
});

for (const state of ["running", "unknown"] as const)
it(`does not turn a logical exit receipt and ${state} native state into disposal authority`, () => {
  expect(githubSettlement([started], [ended], [link], observed(state), new Set()).kind).toBe("pending");
});

for (const code of [0, 1]) it(`allows natural helper exit ${code} only after native end, without asserting a product pass`, () => {
  expect(githubSettlement([started], [{ ...ended, code }], [link], observed("ended"), new Set()).kind).toBe("settled");
});

it("retains forced lease exits and uncertain underlying command work", () => {
  expect(githubSettlement([started], [{ ...ended, code: 78 }], [link], observed("ended"), new Set()).kind).toBe("uncertain");
  expect(githubSettlement([started], [ended], [link], observed("ended"), new Set([ended.id])).kind).toBe("uncertain");
});
