import { useId, useState, type ReactNode } from "react";
import {
  BookOpen,
  CircleHelp,
  Compass,
  GitPullRequest,
  Hand,
  Lightbulb,
  Map as MapIcon,
  Monitor,
  PackageSearch,
  RotateCw,
  Scale,
  ShieldQuestion,
  SquareTerminal,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import {
  CHECK_NAMES,
  checkDecisionLabel,
  checkOf,
  decisionEvidence,
  deliveryDecisionProblem,
  deliveryLabel,
  fixFor,
  proofGap,
  reviewDecisionPending,
  wontStartFix,
  type InboxItem,
  type InboxKind,
  type State,
  type Tone,
} from "@petrina/core";
import { sim, useEngineStatus, useUnsent } from "../engine";
import { ago, type Lookup } from "../lib";
import { followLink } from "../routes";
import { ProductName, ProfileText, RoleAvatar } from "./bits";
import { UnsentNote } from "./EngineState";
import { openHandBack, ReopenButton } from "./TakeOver";
import type { SheetTab } from "./TaskCard";
import { FixSteps } from "./Tools";

const KIND: Record<InboxKind, { label: string; icon: LucideIcon; tone: Tone }> = {
  "maintenance-settings": { label: "Agent settings", icon: TriangleAlert, tone: "amber" },
  question: { label: "Question", icon: CircleHelp, tone: "violet" },
  permission: { label: "Permission", icon: ShieldQuestion, tone: "amber" },
  plan: { label: "Plan check", icon: MapIcon, tone: "indigo" },
  design: { label: "Design check", icon: Compass, tone: "violet" },
  disagreement: { label: "Disagreement", icon: Scale, tone: "purple" },
  delivery: { label: "Ready to ship", icon: GitPullRequest, tone: "green" },
  stuck: { label: "Stuck", icon: TriangleAlert, tone: "slate" },
  shipping: { label: "Shipping was interrupted", icon: PackageSearch, tone: "amber" },
  driving: { label: "You're driving", icon: SquareTerminal, tone: "blue" },
  guide: { label: "Review guide", icon: BookOpen, tone: "teal" },
  learnings: { label: "Learnings", icon: Lightbulb, tone: "teal" },
  screen: { label: "Screen", icon: Monitor, tone: "slate" },
};

/** One thing waiting on the coordinator. The inbox and the session show it the same way. */
export function Ask({
  item,
  state,
  find,
  onOpen,
}: {
  item: InboxItem;
  state: State;
  find: Lookup;
  onOpen: (taskId: string, tab?: SheetTab) => void;
}) {
  const [reply, setReply] = useState("");
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const [showDetail, setShowDetail] = useState(false);
  const [reopened, setReopened] = useState<string>();
  // Lessons the coordinator unticked, by their place in the offer: the rest are added.
  const offer = `${item.id}:${item.body ?? ""}`;
  const [selection, setSelection] = useState<{ offer: string; dropped: number[] }>({ offer, dropped: [] });
  const dropped = selection.offer === offer ? selection.dropped : [];
  const lessons =
    item.kind === "learnings"
      ? (item.body ?? "")
          .split("\n")
          .map((line) => line.replace(/^- /, ""))
          .filter(Boolean)
      : [];
  const kept = lessons.map((_, index) => index).filter((index) => !dropped.includes(index));
  const task = find.task(item.taskId);
  const contextTask = task ?? find.finishedTask(item.taskId);
  const product = find.product(contextTask?.productId);
  // A delivery whose review rounds ran out with Important findings open is a decision, not "ready to ship".
  const unsettled =
    item.kind === "delivery"
    && ((task && !!proofGap(task))
      || task?.acceptanceUnverified === true
      || (task?.findings.some((finding) => finding.status === "open" && finding.severity === "blocking") ?? false));
  const checkIssue = task && !reviewDecisionPending(task) ? deliveryDecisionProblem(task) : undefined;
  const kind =
    item.kind === "delivery" && checkIssue
      ? {
          ...KIND.delivery,
          label: checkDecisionLabel(task!)!,
          tone: "amber" as const,
        }
      : unsettled
        ? {
            ...KIND.delivery,
            label: "Your call",
            tone: "amber" as const,
          }
        : KIND[item.kind];
  const Icon = kind.icon;
  const role = find.role(item.roleId);
  const profile = find.profile(item.profileId);
  const titleId = useId();
  const unsent = useUnsent().filter((entry) => entry.itemId === item.id);
  // While an answer is on its way the choices wait; one the engine refused gives them back.
  const sending = unsent.some((entry) => !entry.refused);
  const connected = useEngineStatus().link === "live";

  // The quiet "send it back with a note" action every checkpoint has.
  const sendBack = (label: string, placeholder = "What should change?", send = "Send"): ReactNode =>
    noting ? (
      <form
        className="reply"
        style={{ flexBasis: "100%" }}
        onSubmit={(event) => {
          event.preventDefault();
          if (note.trim()) sim.requestChanges(item.id, note.trim());
        }}
      >
        <input
          autoFocus
          aria-label={placeholder}
          placeholder={placeholder}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setNoting(false);
            }
          }}
        />
        <button className="btn" type="submit" disabled={!note.trim()}>
          {send}
        </button>
      </form>
    ) : (
      <button className="btn quiet" onClick={() => setNoting(true)}>
        {label}
      </button>
    );

  return (
    <article className={`ask ${item.blocking ? "blocking" : ""}`} aria-labelledby={titleId}>
      <div className={`ask-kind tone-${kind.tone}`}>
        <Icon size={14} strokeWidth={2.3} aria-hidden="true" />
        <span>
          {kind.label} <span className="when num">· {ago(item.at, state.now) === "now" ? "just now" : `${ago(item.at, state.now)} ago`}</span>
        </span>
      </div>
      {item.blocking && (
        <div className="ask-blocking">
          <Hand size={14} strokeWidth={2.3} aria-hidden="true" />
          An agent is waiting on this
        </div>
      )}
      <h3 className="ask-title" id={titleId}>
        {item.title}
      </h3>
      {item.toolId ? (
        <ToolFix item={item} state={state} />
      ) : (
        item.body
        && (item.kind === "learnings" ? (
          <ul className="ask-body ask-lessons">
            {lessons.map((line, index) => (
              <li key={index}>
                <label>
                  <input
                    type="checkbox"
                    checked={!dropped.includes(index)}
                    onChange={(event) =>
                      setSelection({
                        offer,
                        dropped: event.target.checked
                          ? dropped.filter((entry) => entry !== index)
                          : [...dropped, index],
                      })
                    }
                  />
                  <span>{line}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ask-body">{item.body}</p>
        ))
      )}
      <div className="ask-context">
        <ProductName product={product} />
        <span aria-hidden="true">·</span>
        <button className="task-link" onClick={() => onOpen(item.taskId)}>
          {contextTask?.title ?? "Open task"}
        </button>
        {role && (
          <>
            <span aria-hidden="true">·</span>
            <span className="who">
              <RoleAvatar role={role} size={16} />
              {role.name}
            </span>
            <ProfileText profile={profile} find={find} />
          </>
        )}
      </div>

      {unsent.length > 0 && (
        <div className="unsent-list" aria-label="Not sent yet">
          {unsent.map((entry) => (
            <UnsentNote key={entry.clientId} entry={entry} live={connected} />
          ))}
        </div>
      )}

      {item.kind === "maintenance-settings" && (
        <div className="actions">
          <button className="btn lead" onClick={() => sim.resolveMaintenanceSettings(item.taskId, "keep")}>
            Keep this run
          </button>
          <button className="btn" onClick={() => sim.resolveMaintenanceSettings(item.taskId, "stop")}>
            Stop this run
          </button>
        </div>
      )}
      {!sending && item.kind === "question" && (
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
      )}

      {!sending && item.kind === "permission" && (
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
      )}

      {!sending && item.kind === "plan" && (
        <div className="ask-actions">
          <button className="btn lead" disabled={!!task?.workError} onClick={() => sim.approve(item.id)}>
            {task?.workRows?.some((row) => row.addition && !row.addition.ready)
              ? `Approve plan and add ${task.workRows.filter((row) => row.addition && !row.addition.ready).length} product${task.workRows.filter((row) => row.addition && !row.addition.ready).length === 1 ? "" : "s"}`
              : "Approve plan"}
          </button>
          <button className="btn" onClick={() => onOpen(item.taskId, "plan")}>
            See the plan
          </button>
          {sendBack("Re-plan…")}
        </div>
      )}

      {!sending && item.kind === "design" && (
        <div className="ask-actions">
          <button className="btn lead" onClick={() => sim.approve(item.id)}>
            Approve design
          </button>
          <button className="btn" onClick={() => onOpen(item.taskId, "design")}>
            Read the brief
          </button>
          {sendBack("Request changes…")}
        </div>
      )}

      {!sending && item.kind === "disagreement" && (
        <>
          <p className="ask-body">
            Your call settles the design: the architect follows it, with no further review round, and you check the
            brief before anything is built.
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
      )}

      {item.kind === "stuck" && (
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
      )}

      {/* Quiet: listed last, with no notification, and never counted as blocking. */}
      {item.kind === "screen" && (
        <div className="ask-actions">
          <button className="btn" onClick={() => sim.allowScreen(item.taskId)}>
            <Monitor size={16} aria-hidden="true" />
            Allow now
          </button>
        </div>
      )}

      {item.kind === "shipping"
        && (task?.repositories?.some((work) => work.pr?.state === "closed" && !work.landingAccepted) ? (
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
        ) : task?.shipping?.carriedOver ? (
          // From before the update: Petrina cannot look it up, so the coordinator checks GitHub and chooses.
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
        ) : (
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
        ))}

      {item.kind === "driving" && (
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
      )}

      {item.kind === "guide" && (
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
      )}

      {item.kind === "learnings" && (
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
      )}

      {!sending && item.kind === "delivery" && (
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
                  decisionEvidence(task).find((check) => check.run?.source && check.result !== "pass")?.run?.source
                  ?? decisionEvidence(task).find((check) => check.run?.source)?.run?.source;
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
      )}
    </article>
  );
}

/**
 * A Stuck item about a tool: the same fix first run and the Library show, for the tool's status now.
 * A tool that wouldn't start keeps its fix and what it said, even when its check now passes: the
 * check opening a conversation is no proof the real start works. A tool that was missing or logged
 * out and now checks out says so, and Retry carries on.
 */
function ToolFix({ item, state }: { item: InboxItem; state: State }) {
  const toolId = item.toolId!;
  const check = checkOf(state.setup?.checks, toolId);
  const status = check.status;
  const platform = state.setup?.platform ?? "darwin";
  const name = CHECK_NAMES[toolId];
  if (!state.setup) return item.body ? <p className="ask-body">{item.body}</p> : null;
  if (item.toolProblem === "not-installed" && status === "unknown") {
    const fix = fixFor(toolId, status, platform)!;
    return (
      <FixSteps
        fix={{
          ...fix,
          sentence: `The latest check of ${name} couldn't run, so Petrina can't confirm it is missing; Retry carries on.`,
        }}
        detail={check.detail}
        name={name}
      />
    );
  }
  const now = status === "not-installed" || status === "logged-out" ? status : undefined;
  if (!now && item.toolProblem !== "wont-start" && status === "ready") {
    return <p className="ask-body">{name} is ready now, so Retry carries on.</p>;
  }
  const problem = now ?? item.toolProblem;
  const fix =
    problem === "not-installed" || problem === "logged-out"
      ? fixFor(toolId, problem, platform)
      : wontStartFix(toolId, platform);
  return fix ? <FixSteps fix={fix} detail={item.detail} name={name} /> : null;
}
