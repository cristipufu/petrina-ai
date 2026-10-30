import { Select } from "./Select";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SquareTerminal, Undo2 } from "lucide-react";
import { TAKE_OVER_WORDS, takeOverBlock, toolName, type HandBackPreview, type Id, type Launched, type State, type Task } from "@petrina/core";
import { mode, sim } from "../engine";
import { duration, type Lookup } from "../lib";
import { useFocusTrap } from "./bits";

// Take over in your terminal, and hand back. Any surface can open the dialogs (the agent footer, a
// card, the Agents page, Needs you); App shows them once, above everything.

type Open = { kind: "take-over" | "hand-back"; taskId: Id } | undefined;
let open: Open;
const listeners = new Set<() => void>();
const set = (next: Open) => {
  open = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const openTakeOver = (taskId: Id) => set({ kind: "take-over", taskId });
export const openHandBack = (taskId: Id) => set({ kind: "hand-back", taskId });

/** "You're driving · 12m". */
export function drivingText(task: Task, now: number): string {
  return task.driving ? `You're driving · ${duration(task.driving.since, now)}` : "";
}

// Reopen terminal runs one request at a time per task, whichever surface asked, so a second click waits for the first.
const reopening = new Set<Id>();
const reopenListeners = new Set<() => void>();
const reopenChanged = () => {
  for (const listener of reopenListeners) listener();
};
const subscribeReopening = (listener: () => void) => {
  reopenListeners.add(listener);
  return () => {
    reopenListeners.delete(listener);
  };
};

/** Open the terminal again, then say what happened: a title, and the reason when it did not open. */
async function reopenTerminal(taskId: Id, onResult: (title: string, detail?: string) => void): Promise<void> {
  if (reopening.has(taskId)) return;
  reopening.add(taskId);
  reopenChanged();
  try {
    const launched = await sim.reopenTerminal(taskId, "open");
    if (launched.problem) onResult("The terminal did not open", `${launched.problem}.`);
    else onResult(`Opened in ${launched.terminal ?? "your terminal"}`);
  } catch (error) {
    onResult("Not reopened", error instanceof Error ? error.message : String(error));
  } finally {
    reopening.delete(taskId);
    reopenChanged();
  }
}

/** Reopen terminal, unavailable while Petrina is already opening it for this task. */
export function ReopenButton({ taskId, className, onResult }: { taskId: Id; className: string; onResult: (title: string, detail?: string) => void }) {
  const busy = useSyncExternalStore(subscribeReopening, () => reopening.has(taskId));
  return (
    <button className={className} disabled={busy} onClick={() => void reopenTerminal(taskId, onResult)}>
      <SquareTerminal size={16} aria-hidden="true" />
      {busy ? "Opening…" : "Reopen terminal"}
    </button>
  );
}

/** The agent footer's take-over control: the button, or what you can do while you drive. */
export function TakeOverControls({ task, state, onToast }: { task: Task; state: State; onToast: (title: string, detail?: string) => void }) {
  if (task.driving) {
    return (
      <span className="driving-controls">
        <span className="label needs-you num">{drivingText(task, state.now)}</span>
        <ReopenButton taskId={task.id} className="btn small quiet" onResult={onToast} />
        <button className="btn small lead" onClick={() => openHandBack(task.id)}>
          <Undo2 size={16} aria-hidden="true" />
          Hand back
        </button>
      </span>
    );
  }
  // The demo keeps its notice: there is no real agent to hand the terminal.
  if (mode === "demo") {
    return (
      <button
        className="btn small"
        disabled={!task.agent}
        title="Open this agent's own tool in your terminal, on the same session"
        onClick={() => onToast(
          "Take over works with real agents",
          "With real agents it opens the agent's own tool in your terminal on this session and pauses the step until you hand back."
        )}
      >
        <SquareTerminal size={16} aria-hidden="true" />
        Take over in terminal
      </button>
    );
  }
  const blocked = takeOverBlock(task, state);
  return (
    <span className="take-over">
      <button
        className="btn small"
        disabled={blocked !== undefined}
        aria-describedby={blocked ? `take-over-why-${task.id}` : undefined}
        onClick={() => openTakeOver(task.id)}
      >
        <SquareTerminal size={16} aria-hidden="true" />
        Take over in terminal
      </button>
      {blocked && (
        <span className="quiet-text take-over-why" id={`take-over-why-${task.id}`}>
          {blocked}
        </span>
      )}
    </span>
  );
}

/** The take-over and hand-back dialogs, whichever is open. */
export function TakeOverDialogs({ state, find, onToast }: { state: State; find: Lookup; onToast: (title: string, detail?: string) => void }) {
  const current = useSyncExternalStore(subscribe, () => open);
  const task = current ? find.task(current.taskId) : undefined;
  if (!current || !task) return null;
  const close = () => set(undefined);
  return current.kind === "take-over" ? <TakeOverDialog
    task={task}
    state={state}
    find={find}
    onClose={close}
    onToast={onToast}
  /> : <HandBackDialog
    task={task}
    find={find}
    onClose={close}
  />;
}

function Command({ launched }: { launched: Launched }) {
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(launched.command);
      setCopied(true);
    } catch {
      // Without clipboard access, the command is selected for the coordinator to copy.
      field.current?.select();
    }
  };
  return (
    <div className="command-box">
      <p>Run this in any terminal. It opens the agent's own tool on the same conversation, and refuses to open a second copy.</p>
      <div className="reply">
        <input
          ref={field}
          className="command"
          readOnly
          aria-label="The command to run"
          value={launched.command}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button className="btn" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function TakeOverDialog({ task, state, find, onClose, onToast }: {
  task: Task;
  state: State;
  find: Lookup;
  onClose: () => void;
  onToast: (title: string, detail?: string) => void
}) {
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box, onClose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [launched, setLaunched] = useState<Launched>();
  const conversation = task.conversation?.roleId === task.agent?.roleId ? task.conversation : undefined;
  const role = conversation?.role ?? find.role(task.agent?.roleId);
  const canEdit = conversation?.access?.canEdit ?? role?.canEdit;
  const profile = find.profile(task.agent?.profileId);
  const tool = toolName(profile?.toolId);
  const terminals = state.terminals ?? [];
  const terminal = terminals.find((entry) => entry.id === state.terminal) ?? terminals[0];
  const blocked = takeOverBlock(task, state);

  const go = async (how: "open" | "copy") => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await sim.takeOver(task.id, how);
      if (how === "open" && !result.problem) {
        onToast(`Opened ${tool} in ${result.terminal ?? "your terminal"}`, "You're driving. Close it there when you're done, then hand back.");
        onClose();
      } else {
        setLaunched(result);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="dialog-scrim" onClick={onClose} />
      <div ref={box} className="dialog take-over-dialog" role="dialog" aria-modal="true" aria-labelledby="take-over-title" tabIndex={-1}>
        <h2 className="heading" id="take-over-title">
          {launched ? "You're driving" : "Take over in your terminal?"}
        </h2>
        {launched ? (
          <>
            {launched.problem && (
              <p className="error-text" role="alert">
                {launched.problem}.
              </p>
            )}
            <Command launched={launched} />
            <div className="foot">
              <span className="left">When you're done, close {tool} and click Hand back.</span>
              <button className="btn lead" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="prose">
              {canEdit === false
                ? `Petrina stops the ${role?.name ?? "agent"} first. It only reads, so anything it left unsaved is undone, as always.`
                : `Petrina stops the ${role?.name ?? "agent"} first and saves its unfinished work.`}{" "}
              {TAKE_OVER_WORDS.inCharge(tool)}
            </p>
            <p className="quiet-text">While you drive, the step keeps its seat. Messages you send in Petrina wait for the hand back. When you're done, close {tool} and click Hand back.</p>
            {terminal ? (
              <label className="field-row">
                <span>Opens in</span>
                <Select className="select" value={terminal.id} onChange={(event) => sim.setTerminal(event.target.value)}>
                  {terminals.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </Select>
              </label>
            ) : (
              <p className="label warn">{TAKE_OVER_WORDS.noTerminal}</p>
            )}
            {(error ?? blocked) && (
              <p className="error-text" role="alert">
                {error ?? blocked}
              </p>
            )}
            <div className="foot">
              <span className="left" />
              <button className="btn quiet" onClick={onClose}>
                Cancel
              </button>
              <button className={`btn ${terminal ? "quiet" : "lead"}`} disabled={busy || blocked !== undefined} onClick={() => void go("copy")}>
                Take over and copy a command
              </button>
              {terminal && (
                <button className="btn lead" autoFocus disabled={busy || blocked !== undefined} onClick={() => void go("open")}>
                  {busy ? "Stopping the agent…" : "Take over"}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const names = (list: readonly string[], total: number) => `${list.join(", ")}${total > list.length ? ` and ${total - list.length} more` : ""}`;

function HandBackDialog({ task, find, onClose }: { task: Task; find: Lookup; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box, onClose);
  const [preview, setPreview] = useState<HandBackPreview>();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const role = find.role(task.driving?.roleId)?.name ?? "agent";
  const tool = toolName(task.driving?.toolId);

  const check = async () => {
    setError(undefined);
    setPreview(undefined);
    try {
      setPreview(await sim.handBackPreview(task.id));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  useEffect(() => {
    void check();
  }, [task.id]);

  const handBack = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await sim.handBack(task.id, note.trim(), preview?.open === "unknown");
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  };

  const blocked = preview && (preview.open === "running" || preview.problem);
  return (
    <>
      <div className="dialog-scrim" onClick={onClose} />
      <div ref={box} className="dialog hand-back-dialog" role="dialog" aria-modal="true" aria-labelledby="hand-back-title" tabIndex={-1}>
        <h2 className="heading" id="hand-back-title">
          Hand back to the {role}
        </h2>
        {!preview && !error && <p className="quiet-text">Checking your terminal and the working copy…</p>}
        {preview?.open === "running" && <p className="label warn">{TAKE_OVER_WORDS.stillOpen(tool)}</p>}
        {preview && preview.open !== "running" && preview.problem && <p className="label warn">{preview.problem}</p>}
        {preview && !blocked && (
          <>
            <div className="hand-back-summary">
              <h3>What you changed</h3>
              <p>
                {preview.files === 0 && preview.commits === 0
                  ? "Nothing changed since you took over."
                  : `${plural(
                    preview.files,
                    "file"
                  )} added, changed or removed${preview.files ? ` (${names(
                    preview.names,
                    preview.files
                  )})` : ""}, in ${plural(
                    preview.commits,
                    "commit"
                  )} of yours.`}
                {preview.unsaved && " Petrina saves what you didn't commit as one more commit, marked as yours."}
              </p>
              {preview.saved && (
                <>
                  <h3>The {role}'s unfinished work</h3>
                  <p>
                    Before you took over, Petrina saved it as one commit: {plural(
                      preview.saved.files,
                      "file"
                    )} ({names(
                      preview.saved.names,
                      preview.saved.files
                    )}). The {role} finishes it.
                  </p>
                </>
              )}
            </div>
            <label className="note-box">
              <span>A note for the {role} (optional)</span>
              <textarea
                className="field"
                rows={3}
                maxLength={4000}
                value={note}
                placeholder="What you did, or what it should do next"
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            {preview.open === "unknown" && <p className="label warn">{TAKE_OVER_WORDS.cannotTell(tool)}</p>}
            <p className="quiet-text">The {role} carries on with this step, told what changed.{preview.files ? " The tests check runs on your changes now, and they are reviewed before anything ships." : ""}</p>
          </>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="foot" style={{ marginTop: 16 }}>
          <span className="left" />
          <button className="btn quiet" onClick={onClose}>
            {blocked ? "Close" : "Cancel"}
          </button>
          {(blocked || error) && (
            <button className="btn" onClick={() => void check()}>
              Check again
            </button>
          )}
          {preview && !blocked && (
            <button className="btn lead" disabled={busy} onClick={() => void handBack()}>
              <Undo2 size={16} aria-hidden="true" />
              {busy ? "Handing back…" : preview.open === "unknown" ? "Hand back anyway" : "Hand back"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
