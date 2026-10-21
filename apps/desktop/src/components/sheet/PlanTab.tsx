import { Select } from "../Select";
import { TaskStart } from "../TaskStart";
// The task sheet's Plan tab: why this plan, its risk, and its stages, with who works on each.

import { Check, ShieldCheck } from "lucide-react";
import { MAX_REVIEW_ROUNDS, reviewerAt, type RiskLevel, type Stage, type State, type Task } from "@petrina/core";
import { sim } from "../../engine";
import { profileText, type Lookup } from "../../lib";
import { ProfileText, RoleAvatar } from "../bits";

const KIND_LABEL: Record<Stage["kind"], string> = {
  do: "",
  converge: "Until both agree",
  "review-chain": "At the same time",
  gate: "Your check",
};

const RISK_LABEL: Record<RiskLevel, string> = { low: "Low", medium: "Medium", high: "High" };

export function PlanView({ task, state, find }: { task: Task; state: State; find: Lookup }) {
  const plan = task.plan;
  if (!plan)
    return (
      <>
        <TaskStart key={task.id} task={task} state={state} />
        <div className="empty-state reading">
          The planner writes the plan when the task starts. It picks the roles, the tools and the order for this task.
        </div>
      </>
    );

  const planner = find.profile(plan.plannerProfileId);

  const select = (stage: Stage, list: "profileIds" | "reviewerProfileIds", index: number, value: string, editable: boolean) => {
    const assignment = (list === "profileIds" ? stage.assignments : stage.reviewerAssignments)?.[index];
    return <div className="stage-profile">{editable ? (
      <Select className="select" value={value} aria-label={`Who does ${stage.title.toLowerCase()}`} onChange={(event) => sim.setStageProfile(task.id, stage.id, list, index, event.target.value)}>
        {state.profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profileText(profile, find, true)}
          </option>
        ))}
      </Select>
    ) : (
      <ProfileText profile={find.profile(value)} find={find} full />
    )}{assignment && <details className="assignment-reason"><summary>Why this agent</summary><p>{assignment.reason ?? "A reason was not recorded for this assignment."}</p>
      {assignment.profileId !== value && <p>Requested: {find.profile(assignment.profileId) ? profileText(find.profile(assignment.profileId), find, true) : "a profile no longer in the Library"}.</p>}
      {assignment.changeReason && <p>{assignment.changeReason}</p>}
    </details>}</div>;
  };

  return (
    <>
      <TaskStart key={task.id} task={task} state={state} />
      <section className="sheet-section reading">
        <h2>Why this plan</h2>
        <p className="prose">{plan.rationale}</p>
        {task.risk && (
          <p className="prose">
            <b>{RISK_LABEL[task.risk.level]} risk.</b> {task.risk.why}
          </p>
        )}
        <p className="note">
          Composed by the planner on {profileText(planner, find, true)}. Stages that haven't started can be changed.
        </p>
      </section>

      {plan.products && <section className="sheet-section reading"><h2>Product ownership</h2>{plan.products.map((owner) => <p key={owner.productId}>{state.products.find((product) => product.id === owner.productId)?.name ?? task.workRows?.find((row) => row.choice.productId === owner.productId)?.source?.product.name ?? owner.productId} · Builder: {profileText(find.profile(owner.builderProfileId), find, true)}{owner.productId === task.leadProductId || owner.productId === plan.leadProductId ? " · Leads shared repairs" : ""}</p>)}</section>}
      <section className="sheet-section">
        <h2>Stages</h2>
        <ol className="stages">
          {plan.stages.map((stage, index) => {
            const role = find.role(stage.roleId);
            const reviewerRole = find.role(stage.reviewerRoleId);
            const past = index < task.stageIndex || task.state === "pr-open" || task.state === "done";
            const now = index === task.stageIndex && !past;
            const editable = index > task.stageIndex && task.state !== "done" && task.state !== "cancelled";
            const rounds = task.rounds[stage.id];
            return (
              <li key={stage.id} className={`stage ${past ? "past" : ""} ${now ? "now" : ""}`}>
                <span className="n" aria-hidden="true">
                  {past ? <Check size={14} strokeWidth={3} /> : index + 1}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="head">
                    <span>{stage.title}</span>
                    {KIND_LABEL[stage.kind] && <span className="kind">{KIND_LABEL[stage.kind]}</span>}
                    {stage.kind === "review-chain" ? <span className="kind">{stage.maxRounds ?? 2} planned rounds</span> : stage.maxRounds && <span className="kind">Up to {stage.maxRounds} rounds</span>}
                    {rounds && rounds > 1 && <span className="kind num">Round {rounds}</span>}
                    {now && <span className="label running">Now</span>}
                    {past && <span className="sr-only">Done</span>}
                  </div>
                  {stage.kind === "review-chain" && <p className="note">May continue to {MAX_REVIEW_ROUNDS} rounds while earlier Important findings are fixed. Without progress, you decide.</p>}
                  <div className={`who${stage.kind === "converge" || stage.kind === "review-chain" ? " stage-people" : ""}`}>
                    {stage.kind === "gate" ? (
                      <>
                        <ShieldCheck size={16} aria-hidden="true" />
                        You decide before the squad goes on.
                      </>
                    ) : stage.kind === "converge" ? (
                      <>
                        <div className="stage-person">
                          <span className="stage-role"><RoleAvatar role={role} size={20} />{role?.name}</span>
                          {select(stage, "profileIds", 0, stage.profileIds[0] ?? "", editable)}
                        </div>
                        <div className="stage-person">
                          <span className="stage-role"><RoleAvatar role={reviewerRole} size={20} />{reviewerRole?.name}</span>
                          {select(stage, "reviewerProfileIds", 0, stage.reviewerProfileIds?.[0] ?? "", editable)}
                        </div>
                      </>
                    ) : (
                      <>
                        {stage.kind !== "review-chain" && (
                          <>
                            <RoleAvatar role={role} size={20} />
                            {role?.name}
                          </>
                        )}
                        {stage.profileIds.map((profileId, at) => {
                          const reviewer = stage.kind === "review-chain" ? find.role(reviewerAt(stage, at)) : undefined;
                          return (
                            <div key={`${profileId}-${at}`} className={stage.kind === "review-chain" ? "stage-person" : "row"}>
                              {stage.kind === "review-chain" && <span className="stage-role"><RoleAvatar role={reviewer} size={20} />{reviewer?.name}</span>}
                              {select(stage, "profileIds", at, profileId, editable)}
                            </div>
                          );
                        })}
                        {stage.kind === "review-chain" && editable && (
                          <button className="btn quiet small" onClick={() => sim.addReviewer(task.id, stage.id, "sonnet-medium")}>
                            Add a reviewer
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}
