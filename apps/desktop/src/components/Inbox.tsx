import { forwardRef, useState, type ReactNode } from "react";
import {
  CircleHelp,
  Compass,
  GitPullRequest,
  Hand,
  Map as MapIcon,
  PackageSearch,
  PanelRightClose,
  PartyPopper,
  Scale,
  ShieldQuestion,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { DELIVERY_LABEL, type InboxItem, type InboxKind, type State, type Tone } from "@petrina/core";
import { sim, useEngineStatus, useUnsent } from "../engine";
import { ago, type Lookup } from "../lib";
import { ProductName, ProfileText, RoleAvatar } from "./bits";
import { UnsentNote } from "./EngineState";
import type { SheetTab } from "./TaskCard";

const KIND: Record<InboxKind, { label: string; icon: LucideIcon; tone: Tone }> = {
  question: { label: "Question", icon: CircleHelp, tone: "violet" },
  permission: { label: "Permission", icon: ShieldQuestion, tone: "amber" },
  plan: { label: "Plan check", icon: MapIcon, tone: "indigo" },
  design: { label: "Design check", icon: Compass, tone: "violet" },
  disagreement: { label: "Disagreement", icon: Scale, tone: "purple" },
  delivery: { label: "Ready to ship", icon: GitPullRequest, tone: "green" },
  stuck: { label: "Stuck", icon: TriangleAlert, tone: "slate" },
  shipping: { label: "Shipping was interrupted", icon: PackageSearch, tone: "amber" },
};

interface InboxProps {
  state: State;
  find: Lookup;
  /** Over the board, in narrow windows. */
  overlay: boolean;
  onOpen: (taskId: string, tab?: SheetTab) => void;
  onClose: () => void;
}

export const Inbox = forwardRef<HTMLElement, InboxProps>(function Inbox({ state, find, overlay, onOpen, onClose }, ref) {
  const priorityOf = (item: InboxItem) => find.task(item.taskId)?.startedAt ?? 0;
  const items = [...state.inbox].sort((a, b) => Number(b.blocking) - Number(a.blocking) || priorityOf(a) - priorityOf(b) || a.at - b.at);
  const blocking = items.filter((item) => item.blocking).length;
  const connected = useEngineStatus().link === "live";
  // Answers whose question is gone (a restart dropped it): still shown until the engine has them.
  const orphans = useUnsent().filter((entry) => entry.itemId && !state.inbox.some((item) => item.id === entry.itemId));

  return (
    <aside
      ref={ref}
      className={`inbox ${overlay ? "overlay" : ""}`}
      aria-label="Needs you"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (overlay && event.key === "Escape") onClose();
      }}
    >
      <div className="inbox-head">
        <h2>
          Needs you <span className="n">{items.length}</span>
        </h2>
        <button className="btn ghost icon" aria-label="Hide the inbox" title="Hide the inbox (I)" onClick={onClose}>
          <PanelRightClose size={18} />
        </button>
      </div>
      <p className="inbox-sub">
        {items.length === 0 ? (
          "You're not blocking anyone."
        ) : blocking > 0 ? (
          <>
            <span className="num">{blocking}</span> agent{blocking === 1 ? " is" : "s are"} waiting on you. The rest wait at checkpoints.
          </>
        ) : (
          "Nobody is stuck. These wait at checkpoints."
        )}
      </p>
      <div className="inbox-list">
        {orphans.length > 0 && (
          <div className="unsent-list" aria-label="Not sent yet">
            {orphans.map((entry) => (
              <UnsentNote key={entry.clientId} entry={entry} live={connected} />
            ))}
          </div>
        )}
        {items.length === 0 && (
          <div className="inbox-empty">
            <span className="big">
              <PartyPopper size={22} />
            </span>
            <div>All clear. The squad will ask when it needs you.</div>
          </div>
        )}
        {items.map((item) => (
          <Ask key={item.id} item={item} state={state} find={find} onOpen={onOpen} />
        ))}
      </div>
    </aside>
  );
});

/** One thing waiting on the coordinator. The inbox and the session show it the same way. */
export function Ask({ item, state, find, onOpen }: { item: InboxItem; state: State; find: Lookup; onOpen: InboxProps["onOpen"] }) {
  const [reply, setReply] = useState("");
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const [showDetail, setShowDetail] = useState(false);
  const task = find.task(item.taskId);
  const product = find.product(task?.productId);
  const kind = KIND[item.kind];
  const Icon = kind.icon;
  const role = find.role(item.roleId);
  const profile = find.profile(item.profileId);
  const titleId = `ask-${item.id}`;
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
      {item.body && <p className="ask-body">{item.body}</p>}
      <div className="ask-context">
        <ProductName product={product} />
        <span aria-hidden="true">·</span>
        <button className="task-link" onClick={() => onOpen(item.taskId)}>
          {task?.title}
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

      {!sending && item.kind === "question" && (
        <>
          {item.options && item.options.length > 0 && (
            <div className="choices" role="group" aria-label="Answers">
              {item.options.map((option, index) => (
                <button key={`${option}-${index}`} className={`choice ${index === 0 ? "suggested" : ""}`} onClick={() => sim.answer(item.id, option)}>
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
            <input aria-label="Your answer" placeholder={item.options?.length ? "Or answer in your own words" : "Your answer"} value={reply} onChange={(event) => setReply(event.target.value)} />
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
          <button className="btn lead" onClick={() => sim.approve(item.id)}>
            Approve plan
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
          <p className="ask-body">Your call settles the design: the architect follows it, with no further review round, and you check the brief before anything is built.</p>
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
          <button className="btn lead" onClick={() => sim.retry(item.id)}>
            Try again
          </button>
          <button className="btn" onClick={() => onOpen(item.taskId, "session")}>
            See what happened
          </button>
          <button className="btn quiet danger" onClick={() => sim.cancel(item.taskId)}>
            Cancel task
          </button>
        </div>
      )}

      {item.kind === "shipping" && (
        <div className="ask-actions">
          <button className="btn lead" onClick={() => sim.checkShipping(item.id)} title="Look on GitHub and in the repository again">
            Check again
          </button>
          <button className="btn" onClick={() => sim.shipAgain(item.id)} title="The shipper finishes the interrupted attempt">
            Ship it again
          </button>
          <button className="btn quiet" onClick={() => sim.markDone(item.id)} title="It went out another way">
            Mark as done
          </button>
        </div>
      )}

      {!sending && item.kind === "delivery" && (
        <div className="ask-actions">
          <button className="btn lead" onClick={() => sim.approve(item.id)}>
            <GitPullRequest size={16} aria-hidden="true" />
            {task ? DELIVERY_LABEL[task.delivery] : "Ship it"}
          </button>
          <button className="btn" onClick={() => onOpen(item.taskId, "review")}>
            See the reviews
          </button>
          {sendBack("Send back…")}
        </div>
      )}
    </article>
  );
}
