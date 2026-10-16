import { Pause, Play, SquareTerminal } from "lucide-react";
import { queueOf, slotUses, type State } from "@petrina/core";
import { sim } from "../engine";
import { duration, TOOL_COLORS, type Lookup } from "../lib";
import { ProductChip, ProfileChip, RoleAvatar, ROLE_ICONS } from "./bits";
import { LimitStepper } from "./Pool";
import type { SheetTab } from "./TaskCard";

/** One tile per pool slot: who is in it, what they are doing, and a way in. */
export function AgentsPage({ state, find, onOpen }: { state: State; find: Lookup; onOpen: (taskId: string, tab?: SheetTab) => void }) {
  const holders = slotUses(state)
    .map((use) => find.task(use.taskId))
    .filter((task) => task !== undefined);
  const free = Math.max(0, state.pool.limit - holders.length);
  const upNext = queueOf(state.tasks).filter((task) => !task.held);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Agents</h1>
          <p>
            {holders.length} of {state.pool.limit} slots in use
            {state.pool.paused ? " · pool paused, nothing new starts" : ""}.
          </p>
        </div>
        <div className="tools">
          <LimitStepper limit={state.pool.limit} />
          <button className="btn" onClick={() => sim.setPoolPaused(!state.pool.paused)}>
            {state.pool.paused ? <Play size={14} /> : <Pause size={14} />}
            {state.pool.paused ? "Resume pool" : "Pause pool"}
          </button>
        </div>
      </div>
      <div className="grid">
        {holders.map((task) => {
          const role = find.role(task.agent?.roleId);
          const waiting = task.state === "needs-you";
          return (
            <div key={task.id} className={`tile ${waiting ? "waiting" : ""}`}>
              <div className="row">
                <RoleAvatar role={role} size={30} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 650 }}>{role?.name}</div>
                  <ProfileChip profile={find.profile(task.agent?.profileId)} find={find} />
                </div>
              </div>
              <div className="title">{task.title}</div>
              <div className="status-line" style={{ marginTop: 0 }}>
                <span className={`dot ${task.state}`} />
                {task.statusLine}
              </div>
              <div className="grow" />
              <div className="foot">
                <ProductChip product={find.product(task.productId)} />
                <span className="num">· {duration(task.agent?.since, state.now)}</span>
                <button className={`btn small ${waiting ? "amber" : ""}`} onClick={() => onOpen(task.id, "session")}>
                  <SquareTerminal size={13} />
                  {waiting ? "Answer" : "Join"}
                </button>
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
    </div>
  );
}

/** The squad's roles, the tools found on this machine, and the profiles built from them. */
export function LibraryPage({ state, find }: { state: State; find: Lookup }) {
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

      <div className="section-title">Roles</div>
      <div className="grid">
        {state.roles.map((role) => {
          const Icon = ROLE_ICONS[role.icon];
          return (
            <div key={role.id} className="tile role-card">
              <div className="head">
                <span className={`avatar tone-${role.tone}`} style={{ width: 34, height: 34, borderRadius: 11 }}>
                  <Icon size={18} strokeWidth={2.2} />
                </span>
                <div>
                  <div className="name">{role.name}</div>
                  <span className={`pill ${role.canEdit ? "accent" : ""}`}>{role.canEdit ? "Edits the product" : "Read-only"}</span>
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

      <div className="section-title">Tools on this machine</div>
      <div className="grid">
        {state.tools.map((tool) => (
          <div key={tool.id} className="tile" style={{ minHeight: 0 }}>
            <div className="row between">
              <div className="row">
                <i className="tool-dot" style={{ width: 10, height: 10, borderRadius: 3, background: TOOL_COLORS[tool.id] ?? "var(--slate)" }} />
                <strong>{tool.name}</strong>
              </div>
              <span className={`pill ${tool.status === "ready" ? "ok" : ""}`}>{tool.status === "ready" ? "Ready" : tool.status === "logged-out" ? "Log in needed" : "Not installed"}</span>
            </div>
            <div className="mono" style={{ color: "var(--text-3)" }}>
              {tool.command.join(" ")}
            </div>
            <div style={{ color: "var(--text-3)", fontSize: 12 }}>{tool.models.length ? `Models: ${tool.models.join(", ")}` : "Connects through ACP once installed"}</div>
          </div>
        ))}
      </div>

      <div className="section-title">Profiles</div>
      <div className="grid">
        {state.profiles.map((profile) => (
          <div key={profile.id} className="tile" style={{ minHeight: 0 }}>
            <ProfileChip profile={profile} find={find} />
            <div style={{ color: "var(--text-3)", fontSize: 12.5 }}>
              {find.tool(profile.toolId)?.name} running {profile.model} at {profile.effort} effort. Used in {usage(profile.id)} stages right now.
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
