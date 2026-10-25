import { describe, expect, it } from "vitest";
import { scopesFor } from "../../../src/index.js";
import { repositoryTask } from "../../fixtures/tasks.js";

describe("explicit repository execution contexts", () => {
  it("enumerates canonical owners in approved order, opting into excluded owners without inventing an empty scope", () => {
    const task = repositoryTask();
    const [first, second] = task.repositories!;
    task.activeProductId = second!.productId;
    const excluded = { ...second!, productId: "excluded" };
    task.excludedRepositories = [excluded];
    expect(scopesFor(task).map(scope => scope.work)).toEqual([first!, second!]);
    expect(scopesFor(task)[0]!.work).toBe(first!);
    expect(scopesFor(task, { includeExcluded: true }).at(-1)!.work).toBe(excluded);
    expect(task.activeProductId).toBe(second!.productId);
    task.repositories = [];
    expect(scopesFor(task)).toEqual([]);
    delete task.repositories;
    task.repository = first!;
    expect(scopesFor(task)).toEqual([{ task, work: first! }]);
    expect(scopesFor(task)[0]!.work).toBe(first!);
  });
});
