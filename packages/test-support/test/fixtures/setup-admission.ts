import { SetupSteps } from "../../src/setup-admission.js";
/** Deferred admissions without native timers; policy tests explicitly deliver each scheduled turn. */
export function setupAdmission() {
 const work: (() => void)[] = [];
 const setup = new SetupSteps(next => { work.push(next); });
 return { setup, async drain() { while (work.length) { work.shift()!(); await Promise.resolve(); await Promise.resolve(); } } };
}
