import { Select } from "./Select";
import { Profiles } from "./Profiles";
import { followLink, routeHref } from "../routes";
import { Pause, Play, SquareTerminal, Undo2 } from "lucide-react";
import { mainLine, readyQueue, type State } from "@petrina/core";
import { mode, sim } from "../engine";
import { agentSlots, duration, profileText, type Lookup } from "../lib";
import { ProductName, RoleAvatar } from "./bits";
import { LimitStepper } from "./Pool";
import { drivingText, openHandBack } from "./TakeOver";
import { CheckAgain, shownChecks, ToolList, useCheckOnEnter } from "./Tools";
import { ToolIcon } from "./ToolIcon";
import { RolesSection, type RolePanelTarget } from "./Roles";
import type { SheetTab } from "./TaskCard";

/** One tile per pool slot: who is in it, what they are doing, and a way in. Several reviewers at once have a tile each. */
export function AgentsPage({ state, find, onOpen }: { state: State; find: Lookup; onOpen: (taskId: string, tab?: SheetTab) => void }) {
  const holders = agentSlots(state, find).flatMap(slot => slot.task ? [{ ...slot, task: slot.task }] : []);
  const background = state.backgroundAgents ?? [];
  const filled = holders.length + background.length;
  const free = Math.max(0, state.pool.limit - filled);
  const upNext = readyQueue(state);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Agents</h1>
          <p className="num">
            {filled} of {state.pool.limit} slots in use
            {state.pool.paused ? ". The pool is paused, so nothing new starts." : "."}
          </p>
        </div>
        <div className="tools">
          <LimitStepper limit={state.pool.limit} />
          <button className="btn" onClick={() => sim.setPoolPaused(!state.pool.paused)}>
            {state.pool.paused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
            {state.pool.paused ? "Resume the pool" : "Pause the pool"}
          </button>
        </div>
      </div>
      <div className="grid">
        {holders.map(({ task, agent, work, roleId, profileId, key }) => {
          const role = find.role(roleId);
          const waiting = work ? Boolean(work.waiting) : task.state === "needs-you";
          const driving = task.driving !== undefined;
          return (
            <div key={key} className={`tile ${waiting ? "waiting" : ""}`}>
              <div className="row">
                <RoleAvatar role={role} size={32} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{role?.name}</div>
                  <div className="quiet-text" style={{ fontSize: "var(--fs-meta)", lineHeight: "var(--lh-meta)" }}>
                    {profileText(find.profile(profileId), find, true)}
                  </div>
                </div>
              </div>
              <div className="title">{task.title}</div>
              <p className="card-status">
                <span className={`dot ${waiting ? "needs-you" : work ? "running" : task.state}`} aria-hidden="true" />
                <span>{work?.waiting ?? work?.retrying ?? work?.todo ?? work?.activity ?? mainLine(task)}</span>
              </p>
              <div className="grow" />
              <div className="foot">
                <ProductName product={find.product(task.productId)} />
                {driving ? <span className="num label needs-you">{drivingText(
                  task,
                  state.now
                )}</span> : <span className="num">{duration(
                  agent?.since,
                  state.now
                )}</span>}
                {driving ? (
                  <button className="btn small lead" onClick={() => openHandBack(task.id)}>
                    <Undo2 size={16} aria-hidden="true" />
                    Hand back
                  </button>
                ) : (
                  <button className={`btn small ${waiting ? "lead" : ""}`} onClick={() => onOpen(task.id, "session")}>
                    <SquareTerminal size={16} aria-hidden="true" />
                    {waiting ? "Answer" : "Join"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {background.map((agent) => (
          <div key={agent.id} className="tile">
            <div className="row"><RoleAvatar role={find.role(agent.roleId)} size={32} /><strong>{agent.label}</strong></div>
            <p className="quiet-text">{profileText(find.profile(agent.profileId), find, true)}</p>
            <div className="grow" /><span className="num">{duration(agent.since, state.now)}</span>
          </div>
        ))}
        {Array.from({ length: free }, (_, index) => (
          <div key={`free-${index}`} className="tile free">
            <div style={{ fontWeight: 600 }}>Free slot</div>
            <div>{upNext[index] ? `Next up: ${upNext[index]?.title}` : "The queue is empty"}</div>
          </div>
        ))}
      </div>
      <AgentTools state={state} />
    </div>
  );
}

/** Where "Take over in terminal" opens: the usual terminal on this machine, or the coordinator's pick. */
function TerminalPicker({ state }: { state: State }) {
  const terminals = state.terminals ?? [];
  return (
    <>
      <h2 className="section-title">Your terminal</h2>
      <div className="grid">
        <div className="tile" style={{ minHeight: 0 }}>
          <strong style={{ fontWeight: 600 }}>Take over opens in</strong>
          {terminals.length ? (
            <Select
              className="select"
              aria-label="The terminal take over opens in"
              value={state.terminal ?? ""}
              onChange={(event) => sim.setTerminal(event.target.value)}
            >
              <option value="">The usual one ({terminals[0]!.name})</option>
              {terminals.map((terminal) => (
                <option key={terminal.id} value={terminal.id}>
                  {terminal.name}
                </option>
              ))}
            </Select>
          ) : (
            <div style={{ color: "var(--text-2)" }}>Petrina can't find a terminal on this machine. Take over still works: copy the command it gives you and run it in any terminal.</div>
          )}
        </div>
      </div>
    </>
  );
}

const TOOL_STATUS = { ready: "Ready", "logged-out": "Needs you to log in", "not-installed": "Not installed" } as const;

/** The squad's roles, the tools found on this machine, and the profiles built from them. */
export function LibraryPage({ state, onRole, product = "all", view = "roles", onView, onEditorDialog }: {
  state: State;
  onRole: (target: RolePanelTarget) => void;
  product?: string;
  view?: "roles" | "profiles";
  onView?: (view: "roles" | "profiles") => void;
  onEditorDialog?: (open: boolean) => void
}) {

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Library</h1>
          <p>Roles are separate from tools: any role can run on any tool, model and effort. Edit what each one does, or add your own.</p>
        </div>
      </div>

      <nav
        className="library-views"
        aria-label="Library views"
      >{([
        "roles",
        "profiles"
      ] as const).map(tab => <a
        key={tab}
        className={`btn ${view === tab ? "on" : ""}`}
        aria-current={view === tab ? "page" : undefined}
        href={routeHref({
        view: "library",
        product,
        libraryView: tab
      })}
        onClick={e => followLink(
        e,
        () => onView?.(tab)
      )}
      >{tab[0]!.toUpperCase() + tab.slice(1)}</a>)}</nav>
      {view === "roles" && <RolesSection state={state} onOpen={onRole} />}
      {view === "profiles" && <Profiles state={state} onDialogChange={onEditorDialog} />}
    </div>
  );
}

/** Installed tools and the terminal used to join them belong with the live agents. */
function AgentTools({ state }: { state: State }) {
  useCheckOnEnter(mode === "engine");
  return <>
      <h2 className="section-title">Tools on this machine</h2>
      {state.setup ? (
        <div className="library-tools">
          <ToolList checks={shownChecks(state.setup.checks)} platform={state.setup.platform} />
          <CheckAgain checks={state.setup.checks} />
        </div>
      ) : (
      <div className="grid">
        {state.tools.map((tool) => (
          <div key={tool.id} className="tile" style={{ minHeight: 0 }}>
            <div className="row between">
              <div className="row" style={{ gap: 12 }}>
                <ToolIcon toolId={tool.id} />
                <strong style={{ fontWeight: 600 }}>{tool.name}</strong>
              </div>
              <span className={`label ${tool.status === "ready" ? "ok" : "warn"}`} style={{ fontSize: "var(--fs-meta)", lineHeight: "var(--lh-meta)" }}>
                {TOOL_STATUS[tool.status]}
              </span>
            </div>
            <div style={{ color: "var(--text-2)" }}>{tool.models.length ? `Models: ${tool.models.join(", ")}` : "Connects through ACP once installed"}</div>
          </div>
        ))}
      </div>
      )}

      {state.terminals && <TerminalPicker state={state} />}

  </>;
}
