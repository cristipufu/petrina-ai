// How busy this machine is, as a factor for hang-catching limits. No Engine dependency: stand-ins for
// GitHub and the agents import it too.
import { cpus, loadavg } from "node:os";

/** The most the factor stretches a limit, however busy the machine. */
export const MOST_SLOW = 8;

/**
 * How much longer the time limits are on this machine. A Windows runner takes several times longer to start
 * every engine, agent and git process these tests drive, and so does a machine busy with other work. The limits
 * only catch hangs, so they stretch there; what a test asserts about time (the engine stopping within 10
 * seconds, say) stays as it is.
 */
export let SLOW = Math.max(process.platform === "win32" ? 3 : 1, busy());
let lastLoadSample = Date.now();

/** Keep waits in a test worker proportional as its own parallel work makes the machine busier. */
export function currentSlow(): number {
  const now = Date.now();
  if (now - lastLoadSample >= 1_000) {
    SLOW = Math.max(SLOW, process.platform === "win32" ? 3 : 1, busy());
    lastLoadSample = now;
  }
  return SLOW;
}

/**
 * How much busier than its cores this machine is right now, as a factor for deadlines (1 to 8). Petrina builds
 * itself, so its tests often run while its own agents work on the same machine: a deadline that only holds on
 * an idle machine would fail them for nothing. Windows reports no load, and has its own factor above.
 */
function busy(): number {
  const [load] = loadavg();
  // A test worker often starts several Bun, Git and engine processes at once. On a many-core Mac,
  // waiting until load exceeds the core count misses that I/O and process-start contention. Start
  // stretching waits once the machine is near full, then scale faster as its run queue grows.
  const ratio = (load ?? 0) / Math.max(1, cpus().length);
  return Math.min(MOST_SLOW, Math.max(1, Math.ceil(1 + Math.max(0, ratio - 0.75) * 4)));
}
