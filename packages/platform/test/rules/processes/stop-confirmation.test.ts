import { expect, it } from "bun:test";
import { stoppedProcessStates, type ObservedProcess } from "../../../src/process-snapshots.js";

// What the final list shows of a target that still answers after the forced stop (a program, or its group by its
// negative number). Only a complete list that names it, or every member of its group, defunct shows it ended: a list
// silent about something still present, an empty group, a running member or no list at all leaves it unconfirmed.
// Rows are this check's own columns: number, group, state.
{
  const observer = 1111, self = `${observer} ${observer} S`, leader = 4242, both = [-leader, leader];
  const cases: [string, string | undefined, number[], boolean, ObservedProcess?][] = [
    ["its own row and its group's only member defunct", `${self}\n${leader} ${leader} Z`, both, true],
    ["every member of its group defunct, the leader and one it started", `${self}\n${leader} ${leader} Z\n4243 ${leader} Z+`, both, true],
    ["nothing still present", self, [], true],
    ["a member of its group still running", `${self}\n${leader} ${leader} Z\n4243 ${leader} S`, both, false],
    ["no readable list", undefined, both, false],
    ["a list cut short before this process", `${leader} ${leader} Z`, both, false],
    ["no row for the program, though its group's other member is defunct", `${self}\n4243 ${leader} Z`, both, false, { pid: leader, state: "absent", sources: ["target"] }],
    ["no listed member of its group, though the program's own row is defunct", `${self}\n${leader} 1 Z`, both, false, { pid: leader, state: "absent", sources: ["group"] }],
    ["no row for a lone program", self, [leader], false],
    ["no listed member of a lone group", self, [-leader], false],
  ];
  for (const [name, list, present, ended, observed] of cases) it(`${ended ? "counts" : "never counts"} what is still present after the forced stop as ended with ${name}`, () => {
    const states = stoppedProcessStates(list, present, observer);
    expect(states.ended).toBe(ended);
    if (observed) expect(states.processes).toContainEqual(observed);
  });
}
