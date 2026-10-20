// What the keyboard and the command palette do to a task: pause, hold, resume, and move it in the queue,
// each confirmed with a short message once the engine has it.

import { queueOf, TAKE_OVER_WORDS, type State, type Task } from "@petrina/core";
import { sim } from "./engine";
import type { Lookup } from "./lib";

interface Context {
  state: State;
  find: Lookup;
  /** Connected to the engine right now (always, in the demo): asked at the moment of acting. */
  live: () => boolean;
  /** Whether a task shows with the board's current product and filter. */
  visible: (task: Task) => boolean;
  toast: (title: string, detail?: string) => void;
}

export const canTogglePause = (task: Task): boolean => !task.driving && ["queued", "paused", "running", "needs-you", "waiting"].includes(task.state);
export const canMessage = (task: Task): boolean => task.state !== "done" && task.state !== "cancelled";

export function taskCommands({ state, find, live, visible, toast }: Context) {
  /** Send an action and say so once the engine confirms it; false when it could not be sent. */
  const sendAction = async (action: () => unknown, title: string, detail?: string) => {
    if (!live()) {
      toast("Could not send that action", "Petrina is reconnecting. Try again when it is connected.");
      return false;
    }
    try {
      await action();
      toast(title, detail);
      return true;
    } catch {
      toast("Could not send that action", "The engine did not confirm it. Try again when it is connected.");
      return false;
    }
  };

  /** P: hold or release a queued task, resume a paused one, or pause one at work. */
  const pause = (task: Task) => {
    const name = `“${task.title}”`;
    if (task.driving) { toast("Hand back first", TAKE_OVER_WORDS.handBackFirst); return; }
    if (task.state === "queued") {
      void sendAction(() => sim.setHeld(task.id, !task.held), `${name} ${task.held ? "released" : "held"}`, task.held ? "It can start when a slot is free. P again holds it." : "It stays in the queue and will not start. P again releases it.");
    } else if (task.state === "paused") {
      const waitingForYou = state.inbox.some((item) => item.taskId === task.id && !item.blocking);
      void sendAction(() => sim.resume(task.id), `${name} resumed`, waitingForYou ? "It waits for you at its checkpoint." : "It is ready to start again when a slot is free.");
    } else if (["running", "needs-you", "waiting"].includes(task.state)) {
      const request = state.inbox.some((item) => item.taskId === task.id && (item.kind === "question" || item.kind === "permission") && item.blocking);
      const detail = request ? "Its open request was withdrawn and may be asked again. P to resume" : task.holdsSlot ? "The agent’s current step stopped and will start again after resuming. P to resume" : "It will not start another step. P to resume";
      void sendAction(() => sim.pause(task.id), `${name} paused`, detail);
    } else toast(`${name} cannot be paused`, task.state === "failed" ? "Use Try again to restart this task." : task.state === "backlog" ? "Review the request in Backlog, then queue it when it is ready." : "This task has finished.");
  };

  const moved = async (task: Task, action: () => number | Promise<number>) => {
    if (task.state !== "queued") {
      toast(`“${task.title}” cannot move`, "It has already started. Only queued tasks have a priority.");
      return;
    }
    if (!live()) {
      toast("Could not change priority", "Petrina is reconnecting. Try again when it is connected.");
      return;
    }
    try {
      const hidden = await action();
      if (hidden >= 0) toast(`“${task.title}” moved`, hidden ? `It passed ${hidden} hidden task${hidden === 1 ? "" : "s"}. Their order stays the same.` : "Its queue position has updated.");
    } catch {
      toast("Could not change priority", "The engine did not confirm the move.");
    }
  };

  /** Alt+arrow: one place up or down among the queued tasks the board shows. */
  const move = (task: Task, direction: -1 | 1) => {
    const ids = state.tasks.filter((entry) => entry.state === "queued" && visible(entry)).map((entry) => entry.id);
    void moved(task, () => sim.moveVisibleInQueue(task.id, ids, direction));
  };

  /** A drag on the board: before or after another queued task. */
  const place = (id: string, anchor: string, side: "before" | "after") => {
    const task = find.task(id);
    const queue = queueOf(state.tasks);
    const from = queue.findIndex((entry) => entry.id === id);
    const to = queue.findIndex((entry) => entry.id === anchor);
    const hidden = queue.slice(Math.min(from, to) + 1, Math.max(from, to)).filter((entry) => !visible(entry)).length;
    if (task) void moved(task, async () => ((await sim.placeInQueue(id, anchor, side)) < 0 ? -1 : hidden));
  };

  return { sendAction, pause, move, place };
}
