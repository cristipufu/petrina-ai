// The Overview tab's "What it used": the task's tokens and agent time, then each stage that ran with its agents.

import { CircleAlert, Info } from "lucide-react";
import { count, tokenNumber, type State, type Task } from "@petrina/core";
import { TOOL_COLORS, type Lookup } from "../../lib";
import { useUsage } from "../../usage";
import { RoleAvatar } from "../bits";
import { Amount } from "../Usage";

/** The task sheet's "What it used": totals, then each stage that ran with its agents. */
export function WhatItUsed({ task, state, find, onAbout }: { task: Task; state: State; find: Lookup; onAbout: () => void }) {
  const view = useUsage({ view: "task", taskId: task.id }, state);
  return (
    <section className="sheet-section">
      <div className="row between">
        <h2>What it used</h2>
        <button className="linkish about-link" onClick={onAbout}>
          <Info size={14} aria-hidden="true" />
          About these numbers
        </button>
      </div>
      {!view ? (
        <div className="usage-panel muted">Adding it up…</div>
      ) : view.empty ? (
        <div className="usage-panel muted">{view.empty === "untracked" ? "This task ran before Petrina started keeping track, so its use wasn't recorded." : "Nothing used yet."}</div>
      ) : (
        <div className="usage-panel">
          <div className="usage-total">
            <Amount tokens={view.tokens} time={view.time} />
            <span className="muted"> agent time</span>
          </div>
          <div className="muted small">{view.cacheRead === undefined ? "Input reused from the cache: not reported." : `${tokenNumber(view.cacheRead)} of that was input the tools reused from their cache, as the tools report it.`}</div>
          {view.atLeast && (
            <div className="at-least">
              <CircleAlert size={13} />
              {view.atLeast}
            </div>
          )}
          <div className="usage-stages">
            {view.stages.map((stage) => (
              <div key={stage.stageId} className="usage-stage">
                <div className="head">
                  <span>
                    {stage.title}
                    {stage.removed && <span className="muted small"> · no longer in the plan</span>}
                    {stage.rounds > 1 && <span className="muted small"> · {count(stage.rounds, "round")}</span>}
                  </span>
                  <span className="small">
                    <Amount tokens={stage.tokens} time={stage.time} />
                  </span>
                </div>
                {stage.agents.map((agent) => {
                  const role = find.role(agent.roleId);
                  return (
                    <div key={agent.key} className="usage-agent">
                      <RoleAvatar role={role} size={20} />
                      <div className="who">
                        <span className="name">
                          {role?.name ?? agent.roleId}
                          <span className="tool">
                            <i className="tool-dot" aria-hidden="true" style={{ background: TOOL_COLORS[agent.toolId] ?? "var(--slate)" }} />
                            {find.tool(agent.toolId)?.name ?? agent.toolId}
                          </span>
                        </span>
                        <span className={`settings ${agent.differs || agent.notConfirmed ? "off" : ""}`}>
                          {agent.settings}
                          {agent.rounds > 1 ? ` · ${count(agent.rounds, "round")}` : ""}
                        </span>
                        {agent.models.length > 0 && (
                          <span className="models">
                            {agent.models.map((model) => (
                              <span key={model.label}>
                                {model.label} <span className="num">{tokenNumber(model.tokens)}</span>
                              </span>
                            ))}
                          </span>
                        )}
                      </div>
                      <span className="small amount">
                        <Amount tokens={agent.tokens} time={agent.time} />
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
