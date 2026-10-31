// Native command starter and bounded process-group / tree cleanup for test runners.
import { execFile } from "node:child_process";
import { createProcessHost } from "@petrina/platform/process-host";
import { parseDescendants, type ProcessListRead } from "@petrina/platform/process-tree";
import { CLEANUP_MS } from "./command-budgets.js";
import { SLOW } from "./slow.js";

/** The parts of a started program the runner uses. Runner tests pass private stand-ins through `start`. */
export interface Started {
  readonly pid?: number;
  /** Absent when output goes directly to the caller's descriptors; there is no owned pipe to drain. */
  readonly stdout?: ReadableStream<Uint8Array>;
  readonly stderr?: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  /**
   * The runtime's own record of the exit: null until it collects the program, which frees its number. A stand-in
   * without it gives cleanup no such record.
   */
  readonly exitCode?: number | null;
  readonly signalCode: string | null;
  /** Offered only where the native owner supports a graceful signal; absence requires tree cleanup. */
  interrupt?(signal: "SIGINT" | "SIGTERM"): void;
  kill(signal?: NodeJS.Signals): void;
}

export type Start = (
  argv: string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    stdin: "ignore" | Blob;
    detached: boolean;
    output?: "capture" | "inherit";
  },
) => Started;

/**
 * `confirmed`: cleanup paused the program's process group the moment it began, everything it then found stayed in that
 * group and showed paused, and all of that and whatever held the program's output have ended. `unconfirmed`: some of
 * what it started may still be running, because cleanup could not pause or see it all. A program that left both the
 * group and the program's tree before cleanup began, or as its pause took effect, and closed its output, is beyond any
 * list.
 */
export type Cleanup = "none" | "confirmed" | "unconfirmed";

// A private reference: a test that replaces Bun.spawn or node's child_process to watch or redirect its own
// commands never intercepts repository preparation, another test's programs or their cleanup.
const spawn = Bun.spawn.bind(Bun);
const execute = execFile.bind(undefined);
export const host = createProcessHost(process.platform, (command, args, options, done) =>
  execute(command, [...args], options, (error) => done(error)),
);

/** The canonical native starter, also used by the runner that forwards a graceful interrupt. */
export const startCommand: Start = (argv, { output = "capture", ...options }) => {
  const child = spawn(argv, {
    ...options,
    stdout: output === "inherit" ? "inherit" : "pipe",
    stderr: output === "inherit" ? "inherit" : "pipe",
    windowsHide: true,
  });
  return {
    pid: child.pid,
    exited: child.exited,
    ...(output === "capture"
      ? {
          stdout: child.stdout as ReadableStream<Uint8Array>,
          stderr: child.stderr as ReadableStream<Uint8Array>,
        }
      : {}),
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode as string | null;
    },
    ...(host.groups ? { interrupt: (signal: "SIGINT" | "SIGTERM") => child.kill(signal) } : {}),
    kill: (signal) => child.kill(signal),
  };
};

/**
 * A cleanup helper's output, or undefined unless it exits 0 with its output complete within `ms`. Its own timer
 * ends the wait whatever the helper or the runtime report; a helper still running then is stopped.
 */
function helper(argv: string[], ms: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
    } catch {
      return resolve(undefined);
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* Already gone. */
      }
      resolve(undefined);
    }, ms);
    Promise.all([child.exited, new Response(child.stdout as ReadableStream<Uint8Array>).text()])
      .then(([code, text]) => (code === 0 ? text : undefined), () => undefined)
      .then((text) => {
        clearTimeout(timer);
        resolve(text);
      });
  });
}

/** Every process with its parent, its process group and its state. */
export const readProcesses: ProcessListRead = (timeout) =>
  helper(["ps", "-A", "-o", "pid=,ppid=,pgid=,stat="], timeout);

/**
 * Stop a failed command's program and everything it started, all within CLEANUP_MS × SLOW, and say whether that is
 * confirmed. While the runtime has not collected the program, its group is paused at once, before any look, so nothing
 * in it can start anything while cleanup looks; that group is stopped in the end unless a list shows its number as
 * someone else's. Each list decides afresh what else is the command's (`lookAt`), and only that is signalled by
 * number, right after the list showed it: paused and looked at again until a look shows everything found paused, then
 * stopped, so nothing paused is left paused. Without a list only that group and the program's own handle are stopped.
 * Confirmed needs the group paused first, nothing found outside it, that paused look, nothing found and nothing in the
 * group running in a later list, and the output ended.
 */
export function stopOwned(
  child: Started,
  reported: () => boolean,
  outputEnded: Promise<void>,
  windows: boolean,
  read: ProcessListRead,
): Promise<Cleanup> {
  return new Promise<Cleanup>((resolve) => {
    const budget = CLEANUP_MS * SLOW;
    const end = Date.now() + budget;
    const bound = setTimeout(() => resolve("unconfirmed"), budget);
    (windows ? stopWindows(child, reported, end) : stopUnix(child, reported, read, end))
      // Whatever still holds the output is still running, found or not.
      .then(async (cleanup) => (cleanup === "confirmed" && (await ended(outputEnded, end)) ? cleanup : "unconfirmed"))
      .catch((): Cleanup => "unconfirmed")
      .then((cleanup) => {
        clearTimeout(bound);
        resolve(cleanup);
      });
  });
}

/** Whether the output ends by `end`. */
function ended(output: Promise<void>, end: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, end - Date.now()));
    void output.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** A complete list always shows this process; anything else, an empty answer included, is no list. */
const listed = (list: string | undefined): list is string =>
  list !== undefined && list.split("\n").some((line) => Number(line.trim().split(/\s+/)[0]) === process.pid);

const rowsOf = (list: string) =>
  list
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([id]) => Number(id) > 0);

const signal = (targets: readonly number[], name: NodeJS.Signals) => {
  for (const target of targets) {
    try {
      process.kill(target, name);
    } catch {
      /* Already gone. */
    }
  }
};

/** One list, and what it shows as the command's. */
interface Look {
  list: string;
  /** The program is listed as this process's own child, and its exit was not reported before the list was read. */
  owned: boolean;
  /** The program's number is listed under another parent. */
  foreign: boolean;
  /** A member of the program's group besides it, not yet ended, is listed: it keeps the group's number from reuse. */
  kept: boolean;
  /** Everything the list shows as the command's, the program included. */
  mine: number[];
}

/**
 * What one list shows as the command's. Its program, while listed as this process's own child with its exit still
 * unreported when the list was read: listed under another parent, or after that report, its number may have been
 * reused, and neither the group it leads nor anything under it is the command's. Its group's members, while that
 * program or a member not yet ended keeps the number from reuse. Whatever cleanup paused by number that the list
 * shows not yet ended, wherever it moved since: once paused, even before the pause takes effect, it cannot run on to
 * its end and give its number away. And everything under any of those.
 */
function lookAt(list: string, pid: number, reportedBefore: boolean, paused: ReadonlySet<number>): Look {
  const rows = rowsOf(list);
  const program = rows.find(([id]) => Number(id) === pid);
  const owned = !reportedBefore && program !== undefined && Number(program[1]) === process.pid;
  const members =
    program === undefined || owned ? rows.filter(([id, , pgid]) => Number(pgid) === pid && Number(id) !== pid) : [];
  const held = rows
    .filter(([id, , , state]) => paused.has(Number(id)) && !state?.startsWith("Z"))
    .map(([id]) => Number(id));
  const roots = [...(owned ? [pid] : []), ...members.map(([id]) => Number(id)), ...held];
  const kept = members.some(([, , , state]) => !state?.startsWith("Z"));
  return {
    list,
    owned,
    foreign: program !== undefined && Number(program[1]) !== process.pid,
    kept,
    mine: [...new Set([...roots, ...parseDescendants(list, roots)])],
  };
}

const stateIn = (look: Look, id: number) => rowsOf(look.list).find(([row]) => Number(row) === id)?.[3];

async function stopUnix(
  child: Started,
  reported: () => boolean,
  read: ProcessListRead,
  end: number,
): Promise<Cleanup> {
  const pid = child.pid;
  const handle = () => {
    if (!reported()) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* Already gone. */
      }
    }
  };
  // The runtime records no exit until it collects the program, and the program's number, with the group it leads,
  // stays the command's meanwhile. Where it collects on a thread of its own, the record can lag for a moment, but a
  // member of the group still keeps its number. Paused at once, nothing in that group can start anything while
  // cleanup looks, and what it paused keeps the group's number in use until cleanup stops it.
  const pausedFirst = pid !== undefined && !reported() && child.exitCode === null && child.signalCode === null;
  if (pausedFirst) signal([-pid], "SIGSTOP");
  const paused = new Set<number>();
  const found = new Set<number>();
  // Something of the command's found outside its group was not paused with it, and ran while cleanup looked.
  let outside = false;
  /** A list, read within `until`, and what it shows as the command's; undefined when the read fails. */
  const look = async (until: number): Promise<Look | undefined> => {
    const before = reported();
    const list = await read(Math.max(100, Math.min(1_500 * SLOW, until - Date.now())));
    if (!listed(list)) return undefined;
    const shown = lookAt(list, pid!, before, paused);
    for (const id of shown.mine) found.add(id);
    if (rowsOf(list).some(([id, , pgid]) => shown.mine.includes(Number(id)) && Number(pgid) !== pid)) {
      outside = true;
    }
    return shown;
  };
  if (pid === undefined) {
    handle();
    return "unconfirmed";
  }
  let current: Look | undefined;
  // Signals by number go out right after the list that shows their targets, and never to one that has ended. The
  // program itself is reached through its group and its handle: it leads its group for as long as it runs.
  const targets = () => current?.mine.filter((id) => id !== pid && !stateIn(current!, id)?.startsWith("Z")) ?? [];
  // Paused at once, the group stays the command's unless a list shows its number as someone else's: it can only be
  // reused once the group has emptied.
  const group = () => {
    const keepGroup = current
      ? (current.owned && !reported()) || current.kept || (pausedFirst && !current.foreign)
      : pausedFirst;
    return keepGroup ? [-pid] : [];
  };
  let seen = false;
  let fresh = true;
  try {
    // The first look gets half the budget, and a second try when a read fails.
    const until = Date.now() + (end - Date.now()) / 2;
    for (let attempt = 0; attempt < 2 && !current && Date.now() < until; attempt++) {
      current = await look(until);
    }
    // One that ended, or left the command, before it was seen paused may have started something unseen.
    if (current?.owned && !stateIn(current, pid)?.startsWith("Z")) {
      for (let attempt = 0; attempt < 4 && Date.now() < end; attempt++) {
        // After a failed read nothing new is known: what the last list showed is already paused.
        if (fresh) {
          signal([...group(), ...targets()], "SIGSTOP");
          for (const id of targets()) paused.add(id);
        }
        const next = await look(end);
        fresh = next !== undefined;
        if (!next) continue;
        current = next;
        const states = [...found].map((id) => (next.mine.includes(id) ? stateIn(next, id) : undefined));
        if (states.every((state) => state?.startsWith("T"))) {
          seen = pausedFirst && !outside && next.owned;
          break;
        }
        if (states.some((state) => state === undefined || state.startsWith("Z"))) break;
      }
    }
  } finally {
    // Without a list only the group paused at once, and the program through its handle, are stopped.
    signal(targets().reverse(), "SIGKILL");
    signal(group(), "SIGKILL");
    handle();
  }
  if (!seen) return "unconfirmed";
  while (Date.now() < end) {
    const list = await read(Math.max(100, Math.min(1_500 * SLOW, end - Date.now())));
    // A defunct process has ended. Without a state column, a watched process cannot be shown to have ended.
    const stillRunning =
      listed(list) &&
      rowsOf(list).some(([id, , pgid, state]) => (found.has(Number(id)) || Number(pgid) === pid) && !state?.startsWith("Z"));
    if (listed(list) && !stillRunning) return "confirmed";
    await Bun.sleep(50);
  }
  return "unconfirmed";
}

/**
 * Windows ends the program's whole tree with taskkill, under its own deadline. Once the exit was reported the
 * program's number may already belong to someone else, so nothing is signalled by it and cleanup stays
 * unconfirmed: what still holds the output cannot be found. Only the program's own reported exit confirms it.
 */
async function stopWindows(child: Started, reported: () => boolean, end: number): Promise<Cleanup> {
  const pid = child.pid;
  if (reported()) return "unconfirmed";
  if (pid === undefined) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* Already gone. */
    }
    return "unconfirmed";
  }
  const killed = (await host.stopTree?.(pid, Math.max(100, Math.min(2_500 * SLOW, (end - Date.now()) / 2)))) ?? false;
  // The handle stops the program itself even when taskkill failed or ran out of time.
  if (!reported()) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* Already gone. */
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    child.exited.then(
      () => true,
      () => false,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, end - Date.now()));
    }),
  ]);
  clearTimeout(timer);
  return exited && killed ? "confirmed" : "unconfirmed";
}
