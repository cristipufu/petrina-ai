import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, Eye, Lock, Pencil, Plus } from "lucide-react";
import {
  activeRoles,
  addedFacts,
  draftOf,
  permissionLock,
  planUses,
  ROLE_ICON_CHOICES,
  ROLE_LIMITS,
  ROLE_STARTS,
  roleProblems,
  TONE_CHOICES,
  type Role,
  type RoleDraft,
  type RoleField,
  type State,
} from "@petrina/core";
import { EditorPanel } from "./EditorPanel";
import { sim } from "../engine";
import { COLUMN_LABEL, ICON_NAME, RESULT_WORDS, TONE_NAME } from "../lib";
import { ConfirmDialog, ROLE_ICONS, useDismiss } from "./bits";

export type RoleStart = (typeof ROLE_STARTS)[number]["id"];

/** What the role panel shows: a role in the Library, or a new one from a starting point. */
export type RolePanelTarget = { roleId: string } | { start: RoleStart; category?: "maintenance" };

/** The Roles section of the Library: a card per role, and a way to add one. */
export function RolesSection({ state, onOpen }: { state: State; onOpen: (target: RolePanelTarget) => void }) {
  const roles = activeRoles(state.roles);
  const full = roles.filter((role) => role.added).length >= ROLE_LIMITS.added;
  return (
    <section aria-labelledby="roles-title">
      <div className="section-row">
        <h2 className="section-title" id="roles-title">
          Workflow roles
        </h2>
        <AddRoleMenu disabled={full} onPick={(start) => onOpen({ start })} />
      </div>
      {full && <p className="note section-note">You've added {ROLE_LIMITS.added} roles, the most you can. Remove one you no longer use to add another.</p>}
      <div className="grid">
        {roles.filter(role => role.category !== "maintenance").map((role) => (
          <RoleCard key={role.id} role={role} onOpen={() => onOpen({ roleId: role.id })} />
        ))}
      </div>
      <div className="section-row"><h2 className="section-title">Maintenance roles</h2><button
        className="btn outline"
        disabled={full}
        onClick={() => onOpen({
        start: "blank",
        category: "maintenance"
      })}
      ><Plus
        size={16}
        aria-hidden="true"
      />Add a maintenance role</button></div>
      <p className="note section-note">These roles run only from routines. They stay out of ordinary plans.</p>
      <div className="grid">{roles.filter(role => role.category === "maintenance").map(role => <RoleCard
        key={role.id}
        role={role}
        onOpen={() => onOpen({ roleId: role.id })}
      />)}</div>
    </section>
  );
}

function AddRoleMenu({ disabled, onPick }: { disabled: boolean; onPick: (start: RoleStart) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(box, open, close);
  return (
    <span ref={box} className="menu-anchor">
      <button className="btn outline" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((on) => !on)}>
        <Plus size={16} aria-hidden="true" />
        Add a role
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="menu menu-right" role="menu" aria-label="Start a new role">
          {ROLE_STARTS.map((start, index) => {
            const Icon = start.id === "blank" ? Plus : ROLE_ICONS[start.draft.icon];
            return (
              <button
                key={start.id}
                role="menuitem"
                autoFocus={index === 0}
                onClick={() => {
                  setOpen(false);
                  onPick(start.id);
                }}
              >
                <Icon size={16} aria-hidden="true" />
                {start.id === "blank" ? start.label : `Start from a ${start.label}`}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

function badges(role: Role): ReactNode {
  if (role.added) return <span>Added by you</span>;
  return (
    <>
      <span>Built-in</span>
      {role.edited && (
        <>
          <span aria-hidden="true">·</span>
          <span className="label accent">Edited</span>
        </>
      )}
    </>
  );
}

function RoleCard({ role, onOpen }: { role: Role; onOpen: () => void }) {
  const Icon = ROLE_ICONS[role.icon];
  const viewOnly = role.result === "delivery";
  return (
    <article className="tile role-card" aria-labelledby={`role-${role.id}`}>
      <div className="head">
        <span className={`avatar tone-${role.tone}`} aria-hidden="true">
          <Icon size={18} strokeWidth={2.2} />
        </span>
        <div className="who">
          <h3 className="name" id={`role-${role.id}`}>
            {role.name}
          </h3>
          <div className="badges">{badges(role)}</div>
        </div>
      </div>
      <p className="purpose">{role.purpose}</p>
      <dl>
        <dt>May change</dt>
        <dd>{role.canEdit ? "Can change the product" : "Read-only"}</dd>
        <dt>Sees</dt>
        <dd>{role.sees}</dd>
        <dt>Hands back</dt>
        <dd>{role.handsBack || RESULT_WORDS[role.result].label}</dd>
      </dl>
      <div className="grow" />
      <div className="foot">
        <button className="btn small" aria-label={`${viewOnly ? "View" : "Edit"} the ${role.name}`} onClick={onOpen}>
          {viewOnly ? <Eye size={16} aria-hidden="true" /> : <Pencil size={16} aria-hidden="true" />}
          {viewOnly ? "View" : "Edit"}
        </button>
      </div>
    </article>
  );
}

/** The engine's reason, when it is plain words. */
function plain(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure);
  return message.length <= 300 && !/[{}[\]<>"`]/.test(message) ? message : "Petrina's engine could not save that.";
}

const ACCESS = [
  { canEdit: false, label: "Read-only", detail: "Anything it changes is undone when its step ends." },
  { canEdit: true, label: "Can change the product", detail: "Its changes are saved on the task's branch and checked by the reviewers." },
] as const;

const ORDER: readonly RoleField[] = ["name", "purpose", "instructions", "handsBack"];

/**
 * A role, in plain words: what it's for, how it works, what it may change and what it hands back, then
 * what Petrina decides for it. Saving is explicit; closing with unsaved changes asks first. The Release Manager's
 * panel only shows; Petrina handles delivery itself.
 */
export function RolePanel({ state, target, onClose }: { state: State; target: RolePanelTarget; onClose: () => void }) {
  const role = "roleId" in target ? state.roles.find((entry) => entry.id === target.roleId && !entry.removed) : undefined;
  const [initial] = useState<RoleDraft>(() => (role ? draftOf(role) : {
    ...ROLE_STARTS.find((start) => "start" in target && start.id === target.start)!.draft,
    ...("category" in target ? { category: target.category } : {})
  }));
  const [draft, setDraft] = useState(initial);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [asking, setAsking] = useState<"discard" | "reset" | "remove">();
  const id = useId();
  const viewOnly = role?.result === "delivery";
  const naming = !role || role.added;
  const dirty = !viewOnly && JSON.stringify(draft) !== JSON.stringify(initial);
  const requestClose = () => { if (!busy) { if (dirty) setAsking("discard");
  else onClose(); } };
  // The role went away meanwhile (removed in another window): there is nothing left to edit.
  const gone = "roleId" in target && !role;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);

  const set = (change: Partial<RoleDraft>) => setDraft((current) => ({ ...current, ...change }));
  const problems = viewOnly ? {} : roleProblems(draft, state.roles, role);
  const length = (field: RoleField) => (field === "role" ? 0 : String(draft[field as keyof RoleDraft] ?? "").trim().length);
  const limit = (field: RoleField) => (field === "role" ? Infinity : ROLE_LIMITS[field as keyof typeof ROLE_LIMITS]);
  // Missing things show once the coordinator tries to save; text over the limit shows as it is typed.
  const problem = (field: RoleField) => (tried || length(field) > limit(field) ? problems[field] : undefined);
  const lock = role ? permissionLock(role) : draft.result === "findings" ? permissionLock({ id: "", result: "findings" }) : undefined;
  const facts = role?.added || !role ? addedFacts(draft.result, draft.canEdit) : { sees: role.sees, column: role.column };
  const Icon = ROLE_ICONS[draft.icon];
  const unfinished = role?.added ? state.tasks.filter((task) => task.state !== "done" && task.state !== "cancelled" && planUses(task, role.id)) : [];

  const act = async (action: () => unknown | Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      onClose();
    } catch (failure) {
      setError(plain(failure));
      setBusy(false);
    }
  };

  const save = () => {
    if (viewOnly || busy) return;
    setTried(true);
    const first = ORDER.find((field) => problems[field]);
    if (first) {
      document.getElementById(`${id}-${first}`)?.focus();
      return;
    }
    void act(() => (role ? sim.saveRole(role.id, draft) : sim.addRole(draft)));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      save();
    }
  };

  /** A labelled text field, its hint and its problem, announced together. */
  const text = (field: "name" | "purpose" | "instructions" | "handsBack", label: string, hint: string | undefined, rows: number) => {
    const fieldId = `${id}-${field}`;
    const wrong = problem(field);
    const describedBy = [hint ? `${fieldId}-hint` : "", wrong ? `${fieldId}-problem` : ""].filter(Boolean).join(" ") || undefined;
    const common = {
      id: fieldId,
      value: draft[field],
      "aria-invalid": wrong ? true : undefined,
      "aria-describedby": describedBy,
      onChange: (event: { target: { value: string } }) => set({ [field]: event.target.value }),
    };
    const count = length(field);
    return (
      <div className="form-field">
        <label htmlFor={fieldId}>{label}</label>
        {hint && (
          <p className="hint" id={`${fieldId}-hint`}>
            {hint}
          </p>
        )}
        {rows === 1 ? <input
          className="field"
          autoComplete="off"
          autoFocus={naming}
          {...common}
        /> : <textarea
          className="field area"
          rows={rows}
          autoFocus={!naming && field === "purpose"}
          {...common}
        />}
        {count > limit(field) * 0.8 && !wrong && (
          <p className="hint num">
            {count.toLocaleString("en-US")} of {limit(field).toLocaleString("en-US")} characters
          </p>
        )}
        {wrong && (
          <p className="error-text" id={`${fieldId}-problem`}>
            {wrong}
          </p>
        )}
      </div>
    );
  };

  /** A field the coordinator can read but not change. */
  const fact = (label: string, value: ReactNode) => (
    <div className="form-field">
      <h3 className="fact-label">{label}</h3>
      <div className="fact">{value}</div>
    </div>
  );

  const crumb = !role ? "New role" : role.added ? "Added by you" : role.edited ? "Built-in · Edited" : "Built-in";
  if (gone) return null;

  return (
    <>
      <EditorPanel title={role?.name ?? "New role"} caption={role ? crumb : undefined} onClose={requestClose} busy={busy} onKeyDown={onKeyDown} bodyClassName="role-form" icon={<span className={`avatar tone-${draft.tone}`}><Icon size={20} /></span>}
        description={viewOnly ? <p className="lock-note"><Lock
          size={16}
          aria-hidden="true"
        />The Release Manager writes release notes. Petrina handles delivery itself. It can't be edited here.</p> : undefined}
        footer={<>
          {error && (
            <p className="error-text panel-error" role="alert">
              {error}
            </p>
          )}
          {role && !role.added && role.edited && !viewOnly && (
            <button className="btn quiet" disabled={busy} onClick={() => setAsking("reset")}>
              Reset to default
            </button>
          )}
          {role?.added && (
            <button className="btn quiet danger" disabled={busy} onClick={() => setAsking("remove")}>
              Remove role
            </button>
          )}
          <span className="spacer" />
          {viewOnly ? (
            <button className="btn lead" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <button className="btn quiet" disabled={busy} onClick={requestClose}>
                Cancel
              </button>
              <button className="btn lead" disabled={busy} onClick={save}>
                {busy ? "Saving…" : "Save"} <kbd>⌘↵</kbd>
              </button>
            </>
          )}
</>}>
            {viewOnly && role ? (
              <>
                {fact("What it's for", role.purpose)}
                {fact("How it works", role.instructions)}
                {fact("What it may change", "Read-only: anything it changes is undone when its step ends.")}
                {fact("What it hands back", role.handsBack)}
              </>
            ) : (
              <>
                {naming && (
                  <>
                    {text("name", "Name", undefined, 1)}
                    <div className="pickers">
                      <div className="form-field">
                        <span className="field-label" id={`${id}-icon`}>
                          Icon
                        </span>
                        <div className="picks" role="radiogroup" aria-labelledby={`${id}-icon`}>
                          {ROLE_ICON_CHOICES.map((icon) => {
                            const Choice = ROLE_ICONS[icon];
                            return (
                              <button
                                key={icon}
                                type="button"
                                role="radio"
                                aria-checked={draft.icon === icon}
                                aria-label={ICON_NAME[icon]}
                                title={ICON_NAME[icon]}
                                className={`pick ${draft.icon === icon ? "on" : ""}`}
                                onClick={() => set({ icon })}
                              >
                                <Choice size={18} aria-hidden="true" />
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="form-field">
                        <span className="field-label" id={`${id}-tone`}>
                          Colour
                        </span>
                        <div className="picks" role="radiogroup" aria-labelledby={`${id}-tone`}>
                          {TONE_CHOICES.map((tone) => (
                            <button
                              key={tone}
                              type="button"
                              role="radio"
                              aria-checked={draft.tone === tone}
                              aria-label={TONE_NAME[tone]}
                              title={TONE_NAME[tone]}
                              className={`pick swatch tone-${tone} ${draft.tone === tone ? "on" : ""}`}
                              onClick={() => set({ tone })}
                            >
                              <i aria-hidden="true" />
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </>
                )}
                {text(
                  "purpose",
                  "What it's for",
                  draft.category === "maintenance" ? "Helps you choose this role for a routine." : "The planner reads this to decide when to bring the role in.",
                  2
                )}
                {text(
                  "instructions",
                  "How it works",
                  "What the agent is told. Petrina adds the task, your notes, how to hand back the result and what it may change.",
                  8
                )}

                {draft.category !== "maintenance" && <fieldset className="form-field" aria-describedby={`${id}-access-note${lock ? ` ${id}-access-lock` : ""}`}>
                  <legend>What it may change</legend>
                  <div className="options-list">
                    {ACCESS.map((option) => (
                      <label key={option.label} className={`option ${lock ? "locked" : ""}`}>
                        <input
                          type="radio"
                          name={`${id}-access`}
                          checked={draft.canEdit === option.canEdit}
                          disabled={!!lock}
                          onChange={() => set({ canEdit: option.canEdit })}
                        />
                        <span className="t">{option.label}</span>
                        <span className="d">{option.detail}</span>
                      </label>
                    ))}
                  </div>
                  {lock && (
                    <p className="lock-note" id={`${id}-access-lock`}>
                      <Lock size={16} aria-hidden="true" />
                      {lock}
                    </p>
                  )}
                  <p className="hint" id={`${id}-access-note`}>
                    Roles that change the product always work before the final review. Petrina handles delivery itself after the final review.
                  </p>
                </fieldset>}

                <fieldset className="form-field">
                  <legend>What it hands back</legend>
                  {role ? (
                    <>
                      <div className="kind">
                        <Lock size={16} aria-hidden="true" />
                        <span>
                          <span className="t">{draft.category === "maintenance" ? draft.result === "build" ? "Small changes with review" : "Reports only" : RESULT_WORDS[draft.result].label}</span>
                          <span className="d">{RESULT_WORDS[draft.result].detail}</span>
                        </span>
                      </div>
                      <p className="hint">{role.added ? "To hand back something else, add a new role." : "Petrina depends on this kind of result, so it stays."}</p>
                    </>
                  ) : (
                    <>
                      <div className="options-list">
                        {(draft.category === "maintenance" ? ["notes", "build"] as const : ["notes", "findings"] as const).map((result) => (
                          <label key={result} className="option">
                            <input
                              type="radio"
                              name={`${id}-result`}
                              checked={draft.result === result}
                              onChange={() => set(draft.category === "maintenance" ? {
                              result,
                              canEdit: result === "build"
                            } : result === "findings" ? {
                              result,
                              canEdit: false
                            } : { result })}
                            />
                            <span className="t">{draft.category === "maintenance" ? result === "build" ? "Small changes with review" : "Reports only" : RESULT_WORDS[result].label}</span>
                            <span className="d">{RESULT_WORDS[result].detail}</span>
                          </label>
                        ))}
                      </div>
                      <p className="hint">You choose this once. To hand back something else later, add a new role.</p>
                    </>
                  )}
                  {text("handsBack", "Describe what it hands back", undefined, 2)}
                </fieldset>
              </>
            )}

            {fact("Where its tasks sit on the board", COLUMN_LABEL[facts.column])}
            {fact("What it sees", facts.sees)}
      </EditorPanel>

      {asking === "discard" && (
        <ConfirmDialog title="Discard your changes?" confirm="Discard changes" cancel="Keep editing" onCancel={() => setAsking(undefined)} onConfirm={onClose}>
          <p>{role ? `What you changed in the ${role.name} has not been saved.` : "This role has not been added yet."}</p>
        </ConfirmDialog>
      )}
      {asking === "reset" && role && (
        <ConfirmDialog
          title={`Reset the ${role.name} to its default?`}
          confirm="Reset to default"
          onCancel={() => setAsking(undefined)}
          onConfirm={() => {
            setAsking(undefined);
            void act(() => sim.resetRole(role.id));
          }}
        >
          <p>What it's for, how it works, what it may change and what it hands back go back to Petrina's wording. Your changes to this role are lost.</p>
        </ConfirmDialog>
      )}
      {asking === "remove" && role && (
        <ConfirmDialog
          title={`Remove the ${role.name}?`}
          confirm="Remove role"
          onCancel={() => setAsking(undefined)}
          onConfirm={() => {
            setAsking(undefined);
            void act(() => sim.removeRole(role.id));
          }}
        >
          <p>It leaves the Library and the planner stops using it. Tasks already planned with it still run it, and past tasks still show its name.</p>
          {unfinished.length > 0 && (
            <>
              <p>
                {unfinished.length === 1 ? "This unfinished task uses it and will still run it:" : `These ${unfinished.length} unfinished tasks use it and will still run it:`}
              </p>
              <ul className="list compact">
                {unfinished.map((task) => (
                  <li key={task.id}>{task.title}</li>
                ))}
              </ul>
            </>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}
