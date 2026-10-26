import { expect, it } from "vitest";
import { beginAgentStep, BUILT_IN_ROLES, createTaskState, recordBuilderFindingAnswers, type DeepMutable, type Finding } from "../../../src/index.js";

function world(shared = false) {
  const task = createTaskState({ productId: "a", title: "Answer the actual findings", backlog: true },
    [{ id: "a", name: "First", repo: "local/first", tone: "blue" }], { id: "task", timelineId: "created", now: 1, priority: 0 });
  task.fixing = true;
  const step = beginAgentStep(task, "builder", "sol-high", 10, BUILT_IN_ROLES);
  const finding = (id: string, extra: Partial<DeepMutable<Finding>> = {}): DeepMutable<Finding> => {
    const value: DeepMutable<Finding> = { id, text: `Problem ${id}`, severity: "blocking", raisedBy: "opus-high", confirmedBy: [], status: "open", ...extra };
    task.findings.push(value); return value;
  };
  const apply = (given: DeepMutable<Finding>[], answers: { id: string; fixed: boolean; text: string }[], productId = "a") =>
    recordBuilderFindingAnswers(task, given, answers, { productId, shared, at: 20 });
  return { task, step, finding, apply };
}

it("keeps fixed and not-fixed Builder answers distinct and saves an immutable supplied-finding result", () => {
  const f = world(), fixed = f.finding("fixed"), open = f.finding("open");
  expect(f.apply([fixed, open], [{ id: fixed.id, fixed: true, text: "Changed the greeting." }, { id: open.id, fixed: false, text: "The guest case is still broken." }])).toBe(1);
  expect(fixed).toMatchObject({ status: "fixed", answer: { fixed: true, text: "Changed the greeting.", at: 20 } });
  expect(open).toMatchObject({ status: "open", answer: { fixed: false, text: "The guest case is still broken.", at: 20 } });
  expect(f.task.fixing).toBe(false);
  const saved: Finding[] = JSON.parse(JSON.stringify(f.step.result!.findings));
  fixed.answer!.text = "A later answer"; open.status = "dismissed";
  expect(f.step.result!.findings).toEqual(saved);
});

it("applies only still-open references supplied to this Builder, including after a current-list replacement", () => {
  const f = world(), bound = f.finding("same"), closed = f.finding("closed", { status: "dismissed" });
  const replacement = { ...bound, text: "A later same-id record" };
  f.task.findings = [replacement, closed];
  expect(f.apply([bound, closed], [{ id: "unknown", fixed: true, text: "Not supplied." }, { id: closed.id, fixed: true, text: "Already settled." }, { id: bound.id, fixed: true, text: "The supplied record was repaired." }])).toBe(1);
  expect(bound.status).toBe("fixed"); expect(replacement.status).toBe("open");
  expect(replacement.answer).toBeUndefined(); expect(closed.answer).toBeUndefined();
  expect(f.step.result!.findings!.map(finding => finding.text)).toEqual([bound.text, closed.text]);
});

it("keeps shared multi-owner claims open and preserves each product's separate answer", () => {
  const f = world(true), shared = f.finding("shared", { productIds: ["a", "b"] });
  f.apply([shared], [{ id: shared.id, fixed: true, text: "First product repaired." }]);
  f.apply([shared], [{ id: shared.id, fixed: true, text: "Second product repaired." }], "b");
  expect(shared.status).toBe("open");
  expect(shared.answers).toEqual({ a: { fixed: true, text: "First product repaired.", at: 20 }, b: { fixed: true, text: "Second product repaired.", at: 20 } });
});

it("closes a shared single-owner agent claim while keeping native findings open", () => {
  const f = world(true), own = f.finding("own", { productIds: ["a"] }), native = f.finding("native", { productIds: ["a"], raisedBy: "petrina" });
  expect(f.apply([own, native], [own, native].map(finding => ({ id: finding.id, fixed: true, text: "The Builder claims a repair." })))).toBe(2);
  expect(own.status).toBe("fixed"); expect(native.status).toBe("open");
  expect(native.answers!.a).toEqual(native.answer);
});

it("does not let a single-product Builder settle a failed native check", () => {
  const f = world(), check = f.finding("check", { raisedBy: "petrina", text: "Check failed: greeting" }), other = f.finding("other", { raisedBy: "petrina", text: "Another recorded problem" });
  f.apply([check, other], [check, other].map(finding => ({ id: finding.id, fixed: true, text: "The Builder claims a repair." })));
  expect(check).toMatchObject({ status: "open", answer: { fixed: true } });
  expect(other.status).toBe("fixed");
});
