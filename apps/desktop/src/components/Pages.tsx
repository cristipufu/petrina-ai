import { Pause, Play, SquareTerminal, Undo2 } from "lucide-react";
import { queueOf, slotUses, type State } from "@petrina/core";
import { mode, sim } from "../engine";
import { duration, profileText, TOOL_COLORS, type Lookup } from "../lib";
import { ProductName, RoleAvatar, ROLE_ICONS } from "./bits";
import { LimitStepper } from "./Pool";
import { UsageList } from "./Usage";
import { ReviewsPanel } from "./Reviews";
import { drivingText, openHandBack } from "./TakeOver";
import { CheckAgain, shownChecks, ToolList, useCheckOnReturn } from "./Tools";
import type { SheetTab } from "./TaskCard";

/** One tile per pool slot: who is in it, what they are doing, and a way in. Several reviewers at once have a tile each. */
export function AgentsPage({ state, find, onOpen }: { state: State; find: Lookup; onOpen: (taskId: string, tab?: SheetTab) => void }) {
  const holders = slotUses(state).flatMap((use, index) => {
    const task = find.task(use.taskId);
    return task ? [{ task, roleId: use.roleId ?? task.agent?.roleId, profileId: use.profileId ?? task.agent?.profileId, key: `${use.taskId}:${use.profileId ?? index}` }] : [];
  });
  const free = Math.max(0, state.pool.limit - holders.length);
  const upNext = queueOf(state.tasks).filter((task) => !task.held);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Agents</h1>
          <p className="num">
            {holders.length} of {state.pool.limit} slots in use
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
        {holders.map(({ task, roleId, profileId, key }) => {
          const role = find.role(roleId);
          const waiting = task.state === "needs-you";
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
                <span className={`dot ${task.state}`} aria-hidden="true" />
                <span>{task.statusLine}</span>
              </p>
              <div className="grow" />
              <div className="foot">
                <ProductName product={find.product(task.productId)} />
                {driving ? <span className="num label needs-you">{drivingText(task, state.now)}</span> : <span className="num">{duration(task.agent?.since, state.now)}</span>}
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
        {Array.from({ length: free }, (_, index) => (
          <div key={`free-${index}`} className="tile free">
            <div style={{ fontWeight: 600 }}>Free slot</div>
            <div>{upNext[index] ? `Next up: ${upNext[index]?.title}` : "The queue is empty"}</div>
          </div>
        ))}
      </div>

      <h2 className="section-title">Usage</h2>
      <UsageList state={state} />

      <h2 className="section-title">How reviews are going</h2>
      <ReviewsPanel state={state} find={find} />
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
            <select className="select" aria-label="The terminal take over opens in" value={state.terminal ?? ""} onChange={(event) => sim.setTerminal(event.target.value)}>
              <option value="">The usual one ({terminals[0]!.name})</option>
              {terminals.map((terminal) => (
                <option key={terminal.id} value={terminal.id}>
                  {terminal.name}
                </option>
              ))}
            </select>
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
export function LibraryPage({ state, find }: { state: State; find: Lookup }) {
  // Back from running a fix in Terminal: the tools are checked again by themselves.
  useCheckOnReturn(mode === "engine");
  const usage = (profileId: string) =>
    state.tasks.reduce(
      (count, task) =>
        count + (task.plan?.stages.filter((stage) => stage.profileIds.includes(profileId) || stage.reviewerProfileIds?.includes(profileId)).length ?? 0),
      0,
    );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Library</h1>
          <p>Roles are separate from tools: any role can run on any tool, model and effort.</p>
        </div>
      </div>

      <h2 className="section-title">Roles</h2>
      <div className="grid">
        {state.roles.map((role) => {
          const Icon = ROLE_ICONS[role.icon];
          return (
            <div key={role.id} className="tile role-card">
              <div className="head">
                <span className={`avatar tone-${role.tone}`} style={{ width: 32, height: 32, borderRadius: 10 }} aria-hidden="true">
                  <Icon size={18} strokeWidth={2.2} />
                </span>
                <div>
                  <div className="name">{role.name}</div>
                  <div className="quiet-text" style={{ fontSize: "var(--fs-meta)", lineHeight: "var(--lh-meta)" }}>
                    {role.canEdit ? "Edits the product" : "Read-only"}
                    {role.internal ? " · Run by Petrina" : ""}
                  </div>
                </div>
              </div>
              <div style={{ color: "var(--text-2)" }}>{role.purpose}</div>
              <dl>
                <dt>Sees</dt>
                <dd>{role.sees}</dd>
                <dt>Hands back</dt>
                <dd>{role.handsBack}</dd>
              </dl>
            </div>
          );
        })}
      </div>

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
              <div className="row" style={{ gap: 8 }}>
                <i style={{ width: 10, height: 10, borderRadius: 3, background: TOOL_COLORS[tool.id] ?? "var(--slate)" }} aria-hidden="true" />
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

      <h2 className="section-title">Profiles</h2>
      <div className="grid">
        {state.profiles.map((profile) => (
          <div key={profile.id} className="tile" style={{ minHeight: 0 }}>
            <strong style={{ fontWeight: 600 }}>{profileText(profile, find)}</strong>
            <div style={{ color: "var(--text-2)" }}>
              {find.tool(profile.toolId)?.name} running {profile.model} at {profile.effort === "xhigh" ? "extra high" : profile.effort} effort. Used in <span className="num">{usage(profile.id)}</span> stages right now.
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
