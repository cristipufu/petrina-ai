import { TOKEN_PARTS, tokenNumber, type JourneyNode, type State, type Task } from "@petrina/core";
import type { Lookup } from "../lib";
import { useUsage } from "../usage";
import { FigureText } from "./Usage";

/** The saved evidence for this selection; the request key hides any earlier selection immediately. */
export function StepUsage({ node, task, state, find }: { node: JourneyNode; task: Task; state: State; find: Lookup }) {
  const planned = node.state === "next" || node.state === "ahead";
  const agent = node.kind === "agent";
  const view = useUsage(agent && !planned ? { view: "node", taskId: task.id, nodeId: node.id } : undefined, state);
  const empty = !agent ? "No agent token use for this step." : planned ? "This step has not started." : !view ? "Adding up this step’s use…"
    : view.empty === "unavailable" ? "This step ran before per-step records were kept. Its token use cannot be shown on its own."
    : view.empty === "pending" ? "Token use is not reported yet."
    : view.empty === "unreported" ? "The tool did not report token use for this step."
    : view.empty ? "No agent token use for this step." : undefined;
  return <section className="step-usage" aria-label="Usage">
    <h4>Usage</h4>
    <div aria-live="polite" aria-atomic="true">
      {empty ? <p className="note">{empty}</p> : view && <>
        <p className="step-usage-total"><span>Total</span><strong className="num"><FigureText figure={view.tokens} kind="tokens" /></strong></p>
        <dl className="step-usage-parts">
          {TOKEN_PARTS.map(({ key, label }) => <div key={key}><dt>{label}</dt><dd className="num"><FigureText figure={view.detail[key]} kind="tokens" bare missing="not reported" /></dd></div>)}
        </dl>
        {view.breakdownIncomplete && <p className="note">The tool did not report every part of the breakdown.</p>}
        {view.runs.length > 1 && <ul className="step-usage-runs" aria-label="Agent starts">
          {view.runs.map(run => <li key={run.key}>
            <div className="step-usage-run-head"><span>{find.role(run.roleId)?.name ?? run.roleId}{run.seat !== undefined ? ` · Seat ${run.seat}` : ""} · Start {run.start}</span><span className="num"><FigureText figure={run.tokens} kind="tokens" /></span></div>
            <p className="note">{find.tool(run.toolId)?.name ?? run.toolId} · {run.model}</p>
            {run.models.length > 1 && <p className="note">{run.models.map(model => `${model.label}: ${tokenNumber(model.tokens)}`).join(" · ")}</p>}
          </li>)}
        </ul>}
        {view.runs.length === 1 && <p className="note">{find.tool(view.runs[0]!.toolId)?.name ?? view.runs[0]!.toolId} · {view.runs[0]!.model}</p>}
      </>}
      {view?.explanation && <p className="note">{view.explanation}</p>}
    </div>
  </section>;
}
