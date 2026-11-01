import { useState, type ComponentType, type ReactNode } from "react";
import { GitPullRequest, Monitor, RotateCw, Undo2 } from "lucide-react";
import {
  CHECK_NAMES,
  decisionEvidence,
  deliveryDecisionProblem,
  deliveryLabel,
  reviewDecisionPending,
  type InboxItem,
  type InboxKind,
  type Task,
} from "@petrina/core";
import { sim } from "../../engine";
import { followLink } from "../../routes";
import { openHandBack, ReopenButton } from "../TakeOver";
import type { SheetTab } from "../TaskCard";

export interface AskActionProps {
  readonly item: InboxItem;
  readonly task: Task | undefined;
  readonly sending: boolean;
  readonly lessons: readonly string[];
  readonly kept: number[];
  readonly onOpen: (taskId: string, tab?: SheetTab) => void;
  readonly sendBack: (label: string, placeholder?: string, send?: string) => ReactNode;
}

function MaintenanceSettingsActions({ item }: AskActionProps) {
  return (
    <div className="actions">
      <button className="btn lead" onClick={() => sim.resolveMaintenanceSettings(item.taskId, "keep")}>
        Keep this run
      </button>
      <button className="btn" onClick={() => sim.resolveMaintenanceSettings(item.taskId, "stop")}>
        Stop this run
      </button>
    </div>
  );
}

function QuestionActions({ item, sending }: AskActionProps) {
  const [reply, setReply] = useState("");
  if (sending) return null;
  return (
    <>
      {item.options && item.options.length > 0 && (
        <div className="choices" role="group" aria-label="Answers">
          {item.options.map((option, index) => (
            <button
              key={`${option}-${index}`}
              className={`choice ${index === 0 ? "suggested" : ""}`}
              onClick={() => sim.answer(item.id, option)}
            >
              {index === 0 && <span className="tag">Agent's suggestion</span>}
              <span>{option}</span>
            </button>
          ))}
        </div>
      )}
      {item.options && item.options.length > 0 && (
        <button className="btn quiet decide" onClick={() => sim.decideForMe(item.id)}>
          Decide for me
          <span className="ask-note">Chooses the first answer shown above.</span>
        </button>
      )}
      <form
        className="reply"
        onSubmit={(event) => {
          event.preventDefault();
          if (reply.trim()) sim.answer(item.id, reply.trim());
        }}
      >
        <input
          aria-label="Your answer"
          placeholder={item.options?.length ? "Or answer in your own words" : "Your answer"}
          value={reply}
          onChange={(event) => setReply(event.target.value)}
        />
        <button className="btn" type="submit" disabled={!reply.trim()}>
          Answer
        </button>
      </form>
    </>
  );
}

function PermissionActions({ item, sending }: AskActionProps) {
  const [showDetail, setShowDetail] = useState(false);
  if (sending) return null;
  return (
    <>
      <div className="ask-actions">
        <button className="btn lead" onClick={() => sim.allow(item.id, "once")}>
          Allow
        </button>
        <button className="btn quiet danger" onClick={() => sim.deny(item.id)}>
          Deny
        </button>
      </div>
      {item.detail && (
        <div>
          <button className="linkish" aria-expanded={showDetail} onClick={() => setShowDetail((on) => !on)}>
            {showDetail ? "Hide the exact command" : "Show the exact command"}
          </button>
          {showDetail && <div className="detail">{item.detail}</div>}
        </div>
      )}
    </>
  );
}

function PlanActions({ item, task, sending, onOpen, sendBack }: AskActionProps) {
  if (sending) return null;
  const pendingAdditions = task?.workRows?.filter((row) => row.addition && !row.addition.ready).length ?? 0;
  return (
    <div className="ask-actions">
      <button className="btn lead" disabled={!!task?.workError} onClick={() => sim.approve(item.id)}>
        {pendingAdditions > 0
          ? `Approve plan and add ${pendingAdditions} product${pendingAdditions === 1 ? "" : "s"}`
          : "Approve plan"}
      </button>
      <button className="btn" onClick={() => onOpen(item.taskId, "plan")}>
        See the plan
      </button>
      {sendBack("Re-plan…")}
    </div>
  );
}

function DesignActions({ item, sending, onOpen, sendBack }: AskActionProps) {
  if (sending) return null;
  return (
    <div className="ask-actions">
      <button className="btn lead" onClick={() => sim.approve(item.id)}>
        Approve design
      </button>
      <button className="btn" onClick={() => onOpen(item.taskId, "design")}>
        Read the brief
      </button>
      {sendBack("Request changes…")}
    </div>
  );
}

function DisagreementActions({ item, sending, onOpen, sendBack }: AskActionProps) {
  if (sending) return null;
  return (
    <>
      <p className="ask-body">
        Your call settles the design: the architect follows it, with no further review round, and you check the brief
        before anything is built.
      </p>
      <div className="ask-actions">
        <button className="btn lead" onClick={() => onOpen(item.taskId, "design")}>
          Read both sides
        </button>
        <button className="btn quiet" onClick={() => sim.approve(item.id)}>
          Side with the architect
        </button>
        {sendBack("Write my call…", "Your call: what should the design do?", "Make the call")}
      </div>
    </>
  );
}

function StuckActions({ item, onOpen }: AskActionProps) {
  return (
    <div className="ask-actions">
      <button
        className="btn lead"
        onClick={() => sim.retry(item.id)}
        title={item.toolId ? `Checks ${CHECK_NAMES[item.toolId]} again, then tries` : undefined}
      >
        {item.toolId ? "Retry" : "Try again"}
      </button>
      <button className="btn" onClick={() => onOpen(item.taskId, "session")}>
        See what happened
      </button>
      <button className="btn quiet danger" onClick={() => sim.cancel(item.taskId)}>
        Cancel task
      </button>
    </div>
  );
}

function ScreenActions({ item }: AskActionProps) {
  return (
    <div className="ask-actions">
      <button className="btn" onClick={() => sim.allowScreen(item.taskId)}>
        <Monitor size={16} aria-hidden="true" />
        Allow now
      </button>
    </div>
  );
}

function ShippingActions({ item, task }: AskActionProps) {
  if (task?.repositories?.some((work) => work.pr?.state === "closed" && !work.landingAccepted)) {
    return (
      <div className="ask-actions">
        <p className="note">
          Resolving the closed pull requests resumes any unfinished approved deliveries. Open companion pull requests
          still need to merge.
        </p>
        <button className="btn lead" onClick={() => sim.markDone(item.id)}>
          Accept the closed pull requests and continue
        </button>
        <button className="btn" onClick={() => sim.checkShipping(item.id)}>
          Check again
        </button>
      </div>
    );
  }
  if (task?.shipping?.carriedOver) {
    return (
      <div className="ask-actions">
        <button className="btn lead" onClick={() => sim.markDone(item.id)} title="You found it on GitHub">
          It went out (mark as done)
        </button>
        <button
          className="btn"
          onClick={() => sim.shipAgain(item.id)}
          title="A fresh delivery; Petrina checks GitHub before it publishes"
        >
          Ship it again
        </button>
      </div>
    );
  }
  return (
    <div className="ask-actions">
      <button
        className="btn lead"
        onClick={() => sim.checkShipping(item.id)}
        title="Look on GitHub and in the repository again"
      >
        Check again
      </button>
      <button
        className="btn"
        onClick={() => sim.shipAgain(item.id)}
        title="The delivery gets ready again; Petrina checks GitHub before it publishes"
      >
        Ship it again
      </button>
      <button className="btn quiet" onClick={() => sim.markDone(item.id)} title="It went out another way">
        Mark as done
      </button>
    </div>
  );
}

function DrivingActions({ item }: AskActionProps) {
  const [reopened, setReopened] = useState<string>();
  return (
    <>
      <div className="ask-actions">
        <button className="btn lead" onClick={() => openHandBack(item.taskId)}>
          <Undo2 size={16} aria-hidden="true" />
          Hand back
        </button>
        <ReopenButton
          taskId={item.taskId}
          className="btn"
          onResult={(title, detail) => setReopened(detail ?? `${title}.`)}
        />
      </div>
      {reopened && (
        <p className="ask-note" role="status">
          {reopened}
        </p>
      )}
    </>
  );
}

function GuideActions({ item }: AskActionProps) {
  return (
    <>
      {item.detail && <p className="ask-note">{item.detail}</p>}
      <div className="ask-actions">
        <button
          className="btn lead"
          onClick={() => sim.approve(item.id)}
          title="Reviewers check it from now on, and Petrina adds it to REVIEW.md"
        >
          Add it
        </button>
        <button className="btn quiet" onClick={() => sim.decline(item.id)}>
          Not this time
        </button>
      </div>
    </>
  );
}

function LearningsActions({ item, lessons, kept }: AskActionProps) {
  return (
    <>
      {item.detail && <p className="ask-note">{item.detail}</p>}
      <div className="ask-actions">
        <button
          className="btn lead"
          disabled={!kept.length}
          onClick={() => sim.addLessons(item.id, kept)}
          title="The ticked ones join the Learnings section of AGENTS.md with the next delivery"
        >
          {kept.length === lessons.length ? "Add them" : `Add ${kept.length} of ${lessons.length}`}
        </button>
        <button className="btn quiet" onClick={() => sim.decline(item.id)}>
          Not this time
        </button>
      </div>
    </>
  );
}

function DeliveryActions({ item, task, sending, onOpen, sendBack }: AskActionProps) {
  if (sending) return null;
  const checkIssue = task && !reviewDecisionPending(task) ? deliveryDecisionProblem(task) : undefined;
  return (
    <div className="ask-actions">
      <button className="btn lead" onClick={() => (checkIssue ? sim.rerunChecks(item.id) : sim.approve(item.id))}>
        {checkIssue ? <RotateCw size={16} aria-hidden="true" /> : <GitPullRequest size={16} aria-hidden="true" />}
        {task && reviewDecisionPending(task)
          ? "Continue to final checks"
          : checkIssue
            ? "Run checks again"
            : task
              ? deliveryLabel(task)
              : "Ship it"}
      </button>
      {checkIssue && task ? (
        <a
          className="btn"
          onClick={(event) =>
            followLink(event, () => {
              window.history.pushState(window.history.state, "", event.currentTarget.href);
              window.dispatchEvent(new PopStateEvent("popstate"));
            })
          }
          href={(() => {
            const url = new URL(window.location.href);
            url.pathname = `/tasks/${encodeURIComponent(task.id)}`;
            const source =
              decisionEvidence(task).find((check) => check.run?.source && check.result !== "pass")?.run?.source ??
              decisionEvidence(task).find((check) => check.run?.source)?.run?.source;
            if (source) {
              url.searchParams.set("node", source.stepId);
              url.searchParams.set("attempt", source.attemptId);
            }
            return `${url.pathname}${url.search}`;
          })()}
        >
          See original checks
        </a>
      ) : (
        <button className="btn" onClick={() => onOpen(item.taskId, "review")}>
          See the reviews
        </button>
      )}
      {sendBack("Send back…")}
    </div>
  );
}

export const ASK_RENDERERS = {
  "maintenance-settings": MaintenanceSettingsActions,
  question: QuestionActions,
  permission: PermissionActions,
  plan: PlanActions,
  design: DesignActions,
  disagreement: DisagreementActions,
  delivery: DeliveryActions,
  stuck: StuckActions,
  shipping: ShippingActions,
  driving: DrivingActions,
  guide: GuideActions,
  learnings: LearningsActions,
  screen: ScreenActions,
} satisfies Readonly<Record<InboxKind, ComponentType<AskActionProps>>>;
