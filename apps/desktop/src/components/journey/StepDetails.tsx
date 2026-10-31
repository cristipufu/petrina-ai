import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  CornerDownRight,
  FileInput,
  Flag,
  Hourglass,
  MessageCircle,
  MessageSquare,
  SlidersHorizontal,
  Timer,
  User,
  X
} from "lucide-react";
import { decisionEvidence, dependencyLanding, findingKind, type JourneyNode, type State, type Task } from "@petrina/core";
import { duration, EFFORT_LABEL, profileText, type Lookup } from "../../lib";
import { reviewOutcome, reviewRoundGroups } from "../../reviewRound";
import { RoleAvatar } from "../bits";
import { ToolIcon } from "../ToolIcon";
import { TimelineList } from "../Timeline";
import { StepConversation } from "../Session";
import { FindingItem } from "../sheet/ReviewTab";
import { ObjectionItem } from "../sheet/DesignTab";
import { ReviewRoundFindings } from "../ReviewRoundFindings";
import { StepUsage } from "../StepUsage";
import { CheckAttempts } from "../CheckAttempts";
import { StepCheckSetups } from "../CheckSetupObservations";
import { askKind, askOutcome, LANDING_WORDS, profilesOf, since, stateWords, timeOf, unstopped, visibleStepName } from "./journeyWords";

export function StepDetails({ node, task, state, find, now, onPlan, onClose, onOpen, onOriginal, selectedAttempt }: {
  onOriginal: (id: string, attempt?: string) => void;
  selectedAttempt?: string;
  node: JourneyNode;
  task: Task;
  state: State;
  find: Lookup;
  now: number;
  onPlan: () => void;
  onClose?: () => void;
  onOpen?: (taskId: string) => void
}) {
  const [activeTab, setActiveTab] = useState<"overview" | "timeline" | "conversation">("overview");
  useEffect(() => setActiveTab("overview"), [node.id]);
  const role = find.role(node.roleId);
  const profiles = profilesOf(node, find);
  const planned = node.state === "next" || node.state === "ahead";
  const entries = task.timeline.filter((entry) => entry.step === node.id);
  const lines = task.session.filter((line) => line.step === node.id);
  const checkTimeline = entries.find((entry) => entry.text.startsWith("Checks:") || entry.text.startsWith("Checks passed:"));
  const journeySteps = task.journey ?? [];
  const journeyIndex = journeySteps.findIndex((step) => step.id === node.id);
  const previousJourneyStep = journeyIndex > 0 ? journeySteps[journeyIndex - 1] : undefined;
  const ownStep = journeySteps[journeyIndex];
  const nextAgent = journeyIndex >= 0 ? journeySteps.slice(journeyIndex + 1).find((step) => step.kind === "agent") : undefined;
  const checkingThisRound = nextAgent && ownStep && nextAgent.stageId === ownStep.stageId && nextAgent.round === ownStep.round && find.role(nextAgent.roleId)?.result === "votes";
  const handedOn = nextAgent?.agentInputs?.flatMap((input) => input.sections.map((section) => section.body)).join("\n") ?? "";
  // Builders retain their assigned findings and answers as history, not newly raised findings.
  const findings = role?.result === "build" ? undefined : node.result?.findings ?? (role?.result === "findings" && nextAgent
    ? task.findings.filter((finding) => nextAgent.fixing && nextAgent.findingIds?.includes(finding.id) || checkingThisRound && handedOn.includes(`[${finding.id}]`)) : undefined);
  const reviewGroups = useMemo(
    () => role?.result === "findings" ? reviewRoundGroups(
    node,
    task.journey ?? [],
    (id) => find.role(id)?.result
  ) : undefined,
    [
    role?.result,
    node,
    task.journey,
    find
  ]
  );
  const outcome = reviewOutcome(node, role);
  const given = node.agentInputs?.flatMap((input) => input.sections.map((section) => section.body)).join("\n") ?? "";
  const objections = node.result?.objections ?? (role?.result === "objections" && ownStep
    ? task.objections.filter((objection) => objection.round === ownStep.round && (node.team ?? [node.profileId]).includes(objection.raisedBy))
    : role?.result === "brief" ? task.objections.filter((objection) => objection.answer && given.includes(`[${objection.id}]`)) : undefined);
  const supportingChecks = node.productChecks ?? (node.kind === "you" && node.waitsFor === "delivery" && journeyIndex === journeySteps.length - 1 ? decisionEvidence(task) : []);
  const acceptanceChecks = node.acceptanceChecks ? [...node.acceptanceChecks].sort((
    a,
    b
  ) => ({
    pass: 0,
    blocked: 1,
    fail: 2
  }[a.result] - {
    pass: 0,
    blocked: 1,
    fail: 2
  }[b.result])) : [];
  const time = timeOf(node, now);
  const recorded = !planned && !node.legacy && node.startedAt !== undefined;
  // Long tasks keep only their latest timeline events and conversation lines.
  const timelineTrimmed = recorded && task.timeline.length > 0 && task.timeline[0]!.at > node.startedAt!;
  const sessionTrimmed = recorded && task.session.length > 0 && task.session[0]!.at > node.startedAt!;

  return (
    <section className="journey-details" aria-labelledby="journey-details-title">
      <div className="journey-details-head">
        <h3 id="journey-details-title">
          {node.kind === "you" ? (
            <span className="avatar tone-violet" style={{ width: 24, height: 24 }} aria-hidden="true">
              <User size={14} />
            </span>
          ) : node.kind === "wait" ? (
            <span className="avatar tone-slate" style={{ width: 24, height: 24 }} aria-hidden="true">
              <Hourglass size={14} />
            </span>
          ) : (
            <RoleAvatar role={role} size={24} />
          )}
          {visibleStepName(node)}
          <span className={`label ${node.state === "you" ? "needs-you" : node.state === "failed" ? "bad" : node.state === "now" ? "running" : node.state === "done" ? "ok" : ""}`}>{stateWords(node)}</span>
        </h3>
        {onClose && <button className="btn quiet small icon" aria-label="Close the step's details" title="Close" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>}
      </div>

      {!planned && <div className="journey-detail-tabs" role="tablist" aria-label={`${visibleStepName(node)} details`} onKeyDown={(event) => {
        const tabs = ["overview", "timeline", "conversation"] as const;
        const current = tabs.indexOf(activeTab);
        const next = event.key === "ArrowRight" ? (current + 1) % tabs.length : event.key === "ArrowLeft" ? (current + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : current;
        if (next === current) return;
        event.preventDefault();
        setActiveTab(tabs[next]!);
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-journey-tab="${tabs[next]}"]`)?.focus();
      }}>
        {(["overview", "timeline", "conversation"] as const).map((tab) => <button
          key={tab}
          type="button"
          role="tab"
          id={`journey-tab-${node.id}-${tab}`}
          aria-selected={activeTab === tab}
          aria-controls={`journey-panel-${node.id}-${tab}`}
          tabIndex={activeTab === tab ? 0 : -1}
          data-journey-tab={tab}
          onClick={() => setActiveTab(tab)}
        >{tab[0]!.toUpperCase() + tab.slice(1)}</button>)}
      </div>}

      {activeTab === "overview" && <div
        className="journey-tab-panel"
        role="tabpanel"
        id={`journey-panel-${node.id}-overview`}
        aria-labelledby={`journey-tab-${node.id}-overview`}
      >
      {planned ? (
        <>
          <p className="note">
            {node.kind === "you"
              ? "Planned: the squad waits here for your OK before it goes on."
              : node.kind === "petrina"
                ? "Planned: Petrina publishes the checked work itself."
                : `Planned: ${visibleStepName(node)}${profiles.length ? ` on ${profiles.map((profile) => profileText(
                  profile,
                  find,
                  true
                )).join(" and ")}` : ""}.`}
            {node.live ? ` ${unstopped(node.live)}.` : ""}
          </p>
          {node.kind === "agent" && (
            <p className="note">
              Who works on a step that hasn't started can change in the Plan tab.{" "}
              <button className="linkish" onClick={onPlan}>
                Open the Plan tab
              </button>
            </p>
          )}
        </>
      ) : (
        <dl className="journey-facts">
          {profiles.length > 0 && (
            <>
              <dt><Bot size={14} aria-hidden="true" />{node.legacy ? "Planned tool and model" : "Tool and model"}</dt>
              <dd>{profiles.map((profile) => <span
                key={profile.id}
                className="journey-agent-profile"
              ><ToolIcon toolId={profile.toolId} /><span>{profileText(
                profile,
                find,
                true
              )}</span></span>)}</dd>
            </>
          )}
          {node.waitReason && <><dt>Reason for waiting</dt><dd className="prose">{node.waitReason}</dd></>}
          {node.waitsOn?.length ? (
            <>
              <dt>Waits for</dt>
              <dd>
                {node.waitsOn.map((entry) => {
                  const other = find.task(entry.id) ?? find.finishedTask(entry.id);
                  const recorded = node.waitStates?.find((saved) => saved.id === entry.id);
                  return (
                    <span key={entry.id} className="journey-waits">
                      “{other?.title ?? entry.title}” <span className="quiet-text">{recorded ? `${recorded.state}${recorded.decisionNeeded ? " · your decision is needed" : ""}` : other ? LANDING_WORDS[dependencyLanding(other)] : "no longer on the board"}</span>
                    </span>
                  );
                })}
              </dd>
            </>
          ) : null}
          <dt><Clock3 size={14} aria-hidden="true" />{node.work === "check-reuse" ? "Evidence reused" : "Started"}</dt>
          <dd className="num">{node.legacy || node.startedAt === undefined ? "Not recorded" : since(node.startedAt, now)}</dd>
          {time && (
            <>
              <dt><Timer
                size={14}
                aria-hidden="true"
              />{node.kind === "you" ? (node.endedAt === undefined ? "Waiting for" : "Waited") : node.endedAt === undefined ? "Elapsed so far" : "Elapsed"}</dt>
              <dd className="num">{node.kind === "you" ? time : `${time}, including any pauses and waiting`}</dd>
            </>
          )}
          {(outcome || node.live) && (
            <>
              <dt>{outcome ? <Flag size={14} aria-hidden="true" /> : <Activity size={14} aria-hidden="true" />}{outcome ? "Outcome" : "Now"}</dt>
              <dd>{outcome ?? node.live}</dd>
            </>
          )}
          {node.reason && (
            <>
              <dt><ArrowRight size={14} aria-hidden="true" />{node.state === "failed" ? "Stopped because" : "Moved on"}</dt>
              <dd className={node.tone === "back" ? "warn-text" : node.tone === "stuck" ? "bad-text" : ""}>{node.reason}</dd>
            </>
          )}
        </dl>
      )}

      {node.legacy && <p className="note">This step ran before Petrina kept each task's journey. Its saved profile is what was planned; who actually ran it, its time and outcome were not recorded.</p>}

      {node.kind === "agent" && (() => {
        const priorName = previousJourneyStep?.roleId
          ? find.role(previousJourneyStep.roleId)?.name ?? previousJourneyStep.roleId
          : previousJourneyStep?.kind === "petrina"
            ? previousJourneyStep.work === "checks" ? "Automated checks" : "Petrina"
            : previousJourneyStep?.kind === "you" ? "Your checkpoint" : previousJourneyStep?.kind === "wait" ? "The task dependency" : undefined;
        const priorResult = previousJourneyStep?.reason ?? previousJourneyStep?.outcome;
        const inputs = node.agentInputs ?? [];
        const seatKey = (input: typeof inputs[number]) => JSON.stringify([input.roleId, input.profileId, input.reviewerKey]);
        const starts = new Map<string, number>();
        for (const input of inputs) starts.set(seatKey(input), (starts.get(seatKey(input)) ?? 0) + 1);
        const seen = new Map<string, number>();
        return <div className="journey-context">
          <div className="journey-trigger"><h4><CornerDownRight size={16} aria-hidden="true" />Why this step started</h4>
          <p>{previousJourneyStep
            ? `${priorName ?? "The previous step"}${priorResult ? ` handed it on: ${priorResult}.` : " finished, so this step began."}`
            : "This was the first agent step in the plan."}</p></div>
          {inputs.length > 0 ? inputs.map((input, index) => {
            const inputRole = find.role(input.roleId)?.name ?? input.roleId;
            const profile = find.profile(input.profileId);
            const identity = seatKey(input);
            const start = (seen.get(identity) ?? 0) + 1;
            seen.set(identity, start);
            const agentLabel = `${inputRole}${inputs.length > 1 && profile ? ` (${profileText(
              profile,
              find,
              true
            )})` : ""}${input.reviewerKey !== undefined ? ` · Seat ${Number(input.reviewerKey) + 1}` : ""}${starts.get(identity)! > 1 ? ` · Start ${start}` : ""}`;
            return <div className="journey-agent-start" key={`${input.roleId}:${input.profileId}:${input.reviewerKey ?? "main"}:${index}`}>
              <details className="agent-selection">
                <summary><SlidersHorizontal
                  size={16}
                  aria-hidden="true"
                /><span>Agent choice{inputs.length > 1 ? ` · ${agentLabel}` : ""}</span><ChevronRight
                  className="journey-disclosure"
                  size={16}
                  aria-hidden="true"
                /></summary>
                <p>Requested: {input.requestedProfileId ? profileText(
                  find.profile(input.requestedProfileId),
                  find,
                  true
                ) || "A profile no longer in the Library" : "Not recorded"}</p>
                <p>Selected: {profileText(profile, find, true) || "A profile no longer in the Library"}</p>
                {input.assignment && input.assignment.profileId !== input.requestedProfileId && <p>Original assignment: {profileText(
                  find.profile(input.assignment.profileId),
                  find,
                  true
                ) || "A profile no longer in the Library"}</p>}
                {input.assignment?.reason && <p>{input.assignment.reason}</p>}
                {input.assignment?.changeReason && <p>{input.assignment.changeReason}</p>}
                {input.selectionReason && <p>{input.selectionReason}</p>}
                {input.confirmedSettings?.model && <p className="quiet-text">Tool confirmed at start: {input.confirmedSettings.modelName ?? (input.confirmedSettings.model === profile?.modelId ? profile.model : input.confirmedSettings.model)}{input.confirmedSettings.effort ? ` · ${EFFORT_LABEL[input.confirmedSettings.effort as keyof typeof EFFORT_LABEL] ?? input.confirmedSettings.effort}` : ""}</p>}
              </details>
              <details className="journey-input-record">
                <summary><FileInput
                  size={18}
                  aria-hidden="true"
                /><span>Input given to {agentLabel}<span className="journey-input-mode">{input.mode === "continued" ? "Continued conversation" : "Fresh conversation"}</span></span><ChevronRight
                  className="journey-disclosure"
                  size={16}
                  aria-hidden="true"
                /></summary>
                <p className="quiet-text">{input.mode === "continued" ? "Updated job and context for its existing conversation." : "Job and context for a fresh conversation."}{input.stageTitle ? ` Assigned stage: ${input.stageTitle}.` : ""}{input.at !== undefined ? ` Sent ${since(
                  input.at,
                  now
                )}.` : ""}</p>
                {input.taskDescription && <div>
                  <h4>Task request</h4>
                  <p>{input.taskDescription}</p>
                </div>}
                {input.instructions ? <div className="journey-job">
                  <h4>Job instructions</h4>
                  <p>{input.instructions}</p>
                </div> : <p className="note">Job instructions were not recorded for this start.</p>}
                {input.sections.length ? input.sections.map((section, sectionIndex) => <div key={`${section.title}:${sectionIndex}`}>
                  <h4>{section.title}</h4>
                  <p>{section.body}</p>
                </div>) : <p className="note">No additional task context was recorded for this step.</p>}
                {!!input.updates?.length && <div className="journey-input-updates">
                  <h4>Further instructions</h4>
                  {input.updates.map((update, updateIndex) => <div key={updateIndex}>
                    <p className="quiet-text">{update.reason === "message" ? "Coordinator message" : update.reason === "answer" ? "Answer to its question" : update.reason === "redo" ? "Result correction" : "Continuation"}{update.delivery && ` · ${update.delivery === "applied" ? "Heard" : update.delivery === "accepted" ? "Accepted by the tool" : update.delivery === "sending" ? "Sending" : update.delivery === "waiting" ? "Not accepted" : update.delivery === "skipped" ? "Continued without confirmed delivery" : "Delivery unconfirmed"}`} · {since(
                      update.at,
                      now
                    )}</p>
                    <p>{update.text}</p>
                  </div>)}
                </div>}
              </details>
            </div>;
          }) : <p className="note">The exact context given to this older step was not saved.</p>}
        </div>;
      })()}

      <StepUsage node={node} task={task} state={state} find={find} />

      {node.kind === "agent" && role?.result === "build" && (
        <div className="journey-context">
          {node.builderReturn && <p>{node.builderReturn.outcome}. This describes this return; earlier task changes are retained.</p>}
          {ownStep?.agentResults?.map((report, index) => {
            const value = report.value as { summary?: string };
            return value.summary ? <div key={index}><h4>Builder’s report</h4><p>{value.summary}</p></div> : null;
          })}
          {node.fixing && (() => {
            const legacyIds = node.state === "now" && task.fixing
              ? task.findings.filter((finding) => finding.status === "open" && finding.severity !== "pre-existing").map((finding) => finding.id)
              : node.startedAt !== undefined && node.endedAt !== undefined
                ? task.findings.filter((finding) => finding.answer && finding.answer.at >= node.startedAt! && finding.answer.at <= node.endedAt!).map((finding) => finding.id)
                : [];
            const ids = node.findingIds ?? node.result?.findings?.map((finding) => finding.id) ?? legacyIds;
            const findings = ids.map((id) => (node.result?.findings ?? task.findings).find((finding) => finding.id === id)).filter((finding): finding is Task["findings"][number] => !!finding);
            const trigger = journeySteps.find((step) => step.id === ownStep?.trigger?.after);
            const failedChecks = trigger?.kind === "agent" && find.role(trigger.roleId)?.result === "checks"
              ? trigger.acceptanceChecks?.filter((check) => check.result === "fail") ?? [] : [];
            return <>
              {failedChecks.length > 0 ? <>
                <h4 className="journey-section-heading"><ClipboardCheck size={16} aria-hidden="true" />Failed checks that triggered this fix</h4>
                <ul className="journey-check-list">{failedChecks.map((check) => <li key={check.text}><strong>{check.text}</strong>{check.evidence ? <span>{check.evidence}</span> : null}{check.reason ? <span>{check.reason}</span> : null}</li>)}</ul>
              </> : !trigger || (trigger.kind === "agent" && find.role(trigger.roleId)?.result === "checks" && !trigger.acceptanceChecks) ? <p className="note">Acceptance trigger details unavailable.</p> : null}
              <h4 className="journey-section-heading"><ClipboardCheck size={16} aria-hidden="true" />Findings assigned to this fix</h4>
              {findings.length ? <ul className="journey-check-list">{findings.map((finding) => (
                <li key={finding.id}><strong>{finding.text}</strong>{finding.answer ? <span>{!finding.answer.fixed && findingKind(finding) === "product-check" ? "Builder’s explanation — not independently confirmed. " : ""}Builder answered: {finding.answer.fixed ? "fix claimed" : "not fixed"}. {finding.answer.text}</span> : null}</li>
              ))}</ul> : <p className="note">{node.findingIds || node.result?.findings ? "No findings were assigned to this fix." : "This fix round’s assigned findings were not recorded."}</p>}
            </>;
          })()}
        </div>
      )}

      {reviewGroups ? <ReviewRoundFindings
        groups={reviewGroups}
        find={find}
        {...(onOpen ? { onOpen } : {})}
      /> : findings !== undefined && <div className="journey-context">
        <h4 className="journey-section-heading"><ClipboardCheck size={16} aria-hidden="true" />Findings from this step</h4>
        {findings.length ? <><p className="note">{node.result?.findingsSettled ? role?.result === "votes" ? "Settled decisions for this vote step." : "Settled decisions for this review round." : node.result?.findings ? "Hand-back copies; no settled decision was saved." : "Latest recorded status of the findings handed on."}</p><ol className="issues">{findings.map((finding) => <FindingItem
          key={finding.id}
          finding={finding}
          find={find}
          {...(onOpen ? { onOpen } : {})}
        />)}</ol></> : <p className="note">{node.result?.findings ? "No findings were raised or confirmed." : "This step's findings were not recorded separately."}</p>}
      </div>}

      {objections !== undefined && <div className="journey-context">
        <h4 className="journey-section-heading"><MessageSquare
          size={16}
          aria-hidden="true"
        />{role?.result === "brief" ? "Answers to objections" : "Objections from this step"}</h4>
        {objections.length ? <><p className="note">{node.result?.objections ? "As recorded when this step handed back its result." : "Latest recorded answers and status."}</p><ol className="issues">{objections.map((objection) => <ObjectionItem
          key={objection.id}
          objection={objection}
          find={find}
        />)}</ol></> : <p className="note">{node.result?.objections ? role?.result === "brief" ? "No objections needed an answer in this step." : "No objections were raised." : "This step's objection details were not recorded separately."}</p>}
      </div>}

      {acceptanceChecks.length ? (
        <div className="journey-context">
          <h4 className="journey-section-heading"><ClipboardCheck size={16} aria-hidden="true" />Acceptance checks</h4>
          <ul className="journey-check-list">
            {acceptanceChecks.map((check) => <li key={check.text}>
              <span className={`label ${check.result === "pass" ? "ok" : check.result === "fail" ? "bad" : "needs-you"}`}>{check.result === "pass" ? "Passed" : check.result === "fail" ? "Failed" : "Could not verify"}</span>
              <strong>{check.text}</strong>
              {check.evidence ? <span>{check.evidence}</span> : null}
              {check.reason ? <span>{check.reason}</span> : null}
            </li>)}
          </ul>
        </div>
      ) : node.kind === "agent" && role?.result === "checks" && !planned ? <p className="note">{node.state === "now" || node.state === "you" ? "Acceptance testing in progress. No results recorded yet." : "Acceptance results unavailable for this step."}</p> : null}

      {(ownStep?.checkSetups?.length || (node.kind === "petrina" && node.work === "checks")) ? <StepCheckSetups
        attempts={ownStep?.checkSetups ?? []}
        productName={id => find.product(id)?.name ?? task.repositories?.find(work => work.productId === id)?.source?.product.name ?? "Removed product"}
      /> : null}
      {node.kind !== "you" && (node.productChecks?.length || (node.kind === "petrina" && node.work === "checks")) && (() => {
        if (node.productChecks?.length) return <CheckAttempts
          checks={node.productChecks}
          find={find}
          now={now}
          taskId={task.id}
          onOriginal={onOriginal}
          selectedAttempt={selectedAttempt}
          evidence={node.work === "check-reuse"}
          {...(node.state === "now" && task.checkActivity ? { activity: task.checkActivity } : {})}
          {...(node.checkReasons ? { reasons: node.checkReasons } : {})}
        />;
        if (checkTimeline) return <div className="journey-context">
          <h4 className="journey-section-heading"><ClipboardCheck size={16} aria-hidden="true" />Automated check results</h4>
          <p>{checkTimeline.text}</p>
        </div>;
        return <p className="note">Automated check results unavailable for this step.</p>;
      })()}

      {node.kind === "you" && node.waitsFor === "delivery" && <div className="journey-context">
        <h4 className="journey-section-heading"><ClipboardCheck size={16} aria-hidden="true" />Checks behind this delivery decision</h4>
        <p className="note">This is your decision.{supportingChecks.length ? " Supporting check evidence is recorded below." : ""}</p>
        {supportingChecks.length ? <CheckAttempts
          checks={supportingChecks}
          find={find}
          now={now}
          taskId={task.id}
          onOriginal={onOriginal}
          evidence
        /> : <p>Original check evidence unavailable.</p>}
      </div>}

      {node.asks.length > 0 && (
        <div className="journey-asked">
          <h4 className="journey-section-heading"><MessageCircle size={16} aria-hidden="true" />What it asked you</h4>
          <ul>
            {node.asks.map((ask) => (
              <li key={ask.id} className={ask.endedAt === undefined ? "open" : ""}>
                <span className="quiet-text num">
                  {askKind(ask)} · {ask.endedAt === undefined ? `waiting ${duration(ask.at, now)}` : `waited ${duration(ask.at, ask.endedAt)}`}
                </span>
                <span className="journey-ask-title">{ask.title}</span>
                <span className={ask.endedAt === undefined ? "warn-text" : ""}>{askOutcome(ask)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      </div>}

      {activeTab === "timeline" && <div
        className="journey-tab-panel"
        role="tabpanel"
        id={`journey-panel-${node.id}-timeline`}
        aria-labelledby={`journey-tab-${node.id}-timeline`}
      >
      {recorded ? (
        <div className="journey-part">
          <h4>This step on the timeline</h4>
          {entries.length > 0 ? <TimelineList entries={entries} now={now} find={find} /> : null}
          {timelineTrimmed && (
            <p className="note">{entries.length ? "Its earliest events are no longer kept: long tasks keep only their latest timeline events." : "Its part of the timeline is no longer kept: long tasks keep only their latest timeline events."}</p>
          )}
          {!entries.length && !timelineTrimmed && <p className="note">Nothing on the timeline yet.</p>}
        </div>
      ) : <p className="note">This step has no recorded timeline.</p>}
      </div>}

      {activeTab === "conversation" && <div
        className="journey-tab-panel"
        role="tabpanel"
        id={`journey-panel-${node.id}-conversation`}
        aria-labelledby={`journey-tab-${node.id}-conversation`}
      >
        {lines.length > 0 ? <StepConversation
          lines={lines}
          find={find}
          now={now}
          live={node.state === "now" || node.state === "you"}
          taskId={task.id}
          repositories={task.repositories}
          finished={task.state === "done" || task.state === "cancelled"}
        /> : sessionTrimmed ? <p className="note">This step’s earlier conversation is no longer kept; long tasks retain only the latest lines.</p> : <p className="note">No agent conversation was recorded for this step.</p>}
      </div>}
    </section>
  );
}
