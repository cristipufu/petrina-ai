import { stateFixture, taskFixture } from "../../fixtures/state.js";
import { describe, expect, it } from "vitest";
import { queueNeighbour, queuePlacement } from "../../../src/navigation.js";

import { Simulator } from "../../../src/sim.js";
import { queueOf } from "../../../src/scheduler.js";

const demo = stateFixture({ now: 1_000_000 });
demo.tasks = [taskFixture(demo)];

describe("queue moves beside visible neighbours", () => {
  const make = (ids: string[]) => new Simulator({ ...demo, inbox: [], tasks: ids.map((id, priority) => ({ ...demo.tasks[0]!, id, state: "queued", column: "queue", held: id === "A1", priority, holdsSlot: false })), pool: { ...demo.pool, paused: true } });

  const ids = (sim: Simulator) => queueOf(sim.getState().tasks).map((task) => task.id);

  it("moves A2 directly before A1, passing B1 while product B is hidden", () => {
    const sim = make(["A1", "B1", "A2"]);
    expect(sim.moveVisibleInQueue("A2", ["A1", "A2"], -1)).toBe(1);
    expect(ids(sim)).toEqual(["A2", "A1", "B1"]);
  });

  it("drops below the last visible card directly behind it, before hidden trailing cards", () => {
    const sim = make(["A1", "B1", "A2", "B2"]);
    sim.placeInQueue("A1", "A2", "after");
    expect(ids(sim)).toEqual(["B1", "A2", "A1", "B2"]);
  });

  it("builds three quick moves on the latest queue, counting held cards as places", () => {
    const sim = make(["A1", "B1", "A2", "B2", "A3", "A4"]);
    const visible = ["A1", "A2", "A3", "A4"];
    for (let n = 0; n < 3; n++) sim.moveVisibleInQueue("A4", visible, -1);
    expect(ids(sim)).toEqual(["A4", "A1", "B1", "A2", "B2", "A3"]);
    expect(queueNeighbour(ids(sim), visible, "A4", -1)).toBeUndefined();
    expect(queuePlacement(ids(sim), "A4", "A4", "before")).toBeUndefined();
  });
});
