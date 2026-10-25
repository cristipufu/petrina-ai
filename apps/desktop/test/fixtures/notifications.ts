import { stateFixture, taskFixture } from "./state";

/** Only names/ownership and the explicitly supplied inbox are relevant to notification policy. */
export function notificationFixture() {
  const state = stateFixture();
  state.tasks = [
    taskFixture(state, { id: "guest-checkout", title: "Guest checkout" }),
    taskFixture(state, { id: "dark-mode", title: "Dark mode", productId: "notes" }),
    taskFixture(state, { id: "gift-cards", title: "Gift cards" }),
  ];
  return state;
}
