import { stateFixture, taskFixture } from "./state";

export function sessionFixture(now = 1_000_000_000_000) {
  const state = stateFixture(now);
  state.tasks = [
    taskFixture(state, { id: "login-loop", state: "running", column: "building", holdsSlot: true,
      agent: { roleId: "tester", profileId: "sol-high", since: now - 1_000, step: 0 } }),
    taskFixture(state, { id: "dark-mode", state: "needs-you", column: "designing", holdsSlot: true,
      agent: { roleId: "architect", profileId: "opus-high", since: now - 1_000, step: 0 } }),
  ];
  return state;
}
