import { useState } from "react";
import {
  CircleHelp,
  Compass,
  GitPullRequest,
  Map as MapIcon,
  PanelRightClose,
  PartyPopper,
  Scale,
  ShieldQuestion,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { InboxItem, InboxKind, State, Tone } from "@petrina/core";
import { sim } from "../engine";
import { ago, type Lookup } from "../lib";
import { ProductChip, ProfileChip, RoleAvatar } from "./bits";
import type { SheetTab } from "./TaskCard";

const KIND: Record<InboxKind, { label: string; icon: LucideIcon; tone: Tone }> = {
  question: { label: "Question", icon: CircleHelp, tone: "violet" },
  permission: { label: "Permission", icon: ShieldQuestion, tone: "amber" },
  plan: { label: "Plan", icon: MapIcon, tone: "indigo" },
  design: { label: "Design check", icon: Compass, tone: "violet" },
  disagreement: { label: "Disagreement", icon: Scale, tone: "purple" },
  delivery: { label: "Ready to ship", icon: GitPullRequest, tone: "green" },
  stuck: { label: "Stuck", icon: TriangleAlert, tone: "slate" },
};

interface InboxProps {
  state: State;
  find: Lookup;
  onOpen: (taskId: string, tab?: SheetTab) => void;
  onClose: () => void;
}

export function Inbox({ state, find, onOpen, onClose }: InboxProps) {
  const priorityOf = (item: InboxItem) => find.task(item.taskId)?.startedAt ?? 0;
  const items = [...state.inbox].sort((a, b) => Number(b.blocking) - Number(a.blocking) || priorityOf(a) - priorityOf(b) || a.at - b.at);
  const blocking = items.filter((item) => item.blocking).length;

  return (
    <aside className="inbox" aria-label="Needs you">
      <div className="inbox-head">
        <h2>Needs you</h2>
        <span className="n">{items.length}</span>
        <button className="btn ghost icon" title="Hide (I)" onClick={onClose}>
          <PanelRightClose size={16} />
        </button>
      </div>
      <div className="inbox-sub">
        {items.length === 0
          ? "You're not blocking anyone."
          : blocking > 0
            ? `${blocking} agent${blocking === 1 ? " is" : "s are"} waiting on you. The rest wait at checkpoints.`
            : "Nobody is stuck. These wait at checkpoints."}
      </div>
      <div className="inbox-list">
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
}

export function Ask({ item, state, find, onOpen }: { item: InboxItem; state: State; find: Lookup; onOpen: InboxProps["onOpen"] }) {
  const [reply, setReply] = useState("");
  const [noting, setNoting] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const task = find.task(item.taskId);
  const product = find.product(task?.productId);
  const kind = KIND[item.kind];
  const Icon = kind.icon;
  const role = find.role(item.roleId);
  const profile = find.profile(item.profileId);

  const sendBack = (label: string) =>
    noting ? (
      <div className="ask-reply">
        <input
          autoFocus
          placeholder="What should change?"
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && reply.trim()) sim.requestChanges(item.id, reply.trim());
            if (event.key === "Escape") setNoting(false);
          }}
        />
        <button className="btn small" disabled={!reply.trim()} onClick={() => sim.requestChanges(item.id, reply.trim())}>
          Send
        </button>
      </div>
    ) : (
      <button className="btn small ghost" onClick={() => setNoting(true)}>
        {label}
      </button>
    );

  return (
    <article className={`ask ${item.blocking ? "blocking" : ""}`}>
      <div className="ask-head">
        <span className={`kind tone-${kind.tone}`}>
          <Icon size={13} strokeWidth={2.3} />
          {kind.label}
        </span>
        {item.blocking && <span className="pill needs-you">Blocking an agent</span>}
        <span className="when num">{ago(item.at, state.now)}</span>
      </div>
      <div className="ask-title">{item.title}</div>
      {item.body && <div className="ask-body">{item.body}</div>}
      <div className="ask-who">
        <ProductChip product={product} />
        <span>·</span>
        <button className="task-link" onClick={() => onOpen(item.taskId)}>
          {task?.title}
        </button>
        {role && (
          <>
            <span>·</span>
            <RoleAvatar role={role} size={16} />
            {role.name}
            <ProfileChip profile={profile} find={find} showTool={false} />
          </>
        )}
      </div>

      {item.kind === "question" && (
        <>
          <div className="ask-options">
            {item.options?.map((option, index) => (
              <button key={option} className={`btn small ${index === 0 ? "primary" : ""}`} onClick={() => sim.answer(item.id, option)}>
                {option}
              </button>
            ))}
          </div>
          <div className="ask-actions">
            {item.options && item.options.length > 0 && (
              <button className="btn small ghost" onClick={() => sim.decideForMe(item.id)} title="The agent goes with its own recommendation">
                Decide for me
              </button>
            )}
          </div>
          <div className="ask-reply">
            <input
              placeholder="Or answer in your own words"
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && reply.trim()) sim.answer(item.id, reply.trim());
              }}
            />
            <button className="btn small" disabled={!reply.trim()} onClick={() => sim.answer(item.id, reply.trim())}>
              Answer
            </button>
          </div>
        </>
      )}

      {item.kind === "permission" && (
        <>
          <div className="ask-actions">
            <button className="btn small primary" onClick={() => sim.allow(item.id, "once")}>
              Allow once
            </button>
            <button className="btn small" onClick={() => sim.allow(item.id, "always")}>
              Always in {product?.name ?? "this product"}
            </button>
            <button className="btn small ghost danger" onClick={() => sim.deny(item.id)}>
              Deny
            </button>
          </div>
          {item.detail && (
            <div style={{ marginTop: 8 }}>
              <button className="linkish" onClick={() => setShowDetail((on) => !on)}>
                {showDetail ? "Hide details" : "Show the exact command"}
              </button>
              {showDetail && <div className="detail">{item.detail}</div>}
            </div>
          )}
        </>
      )}

      {item.kind === "plan" && (
        <div className="ask-actions">
          <button className="btn small primary" onClick={() => sim.approve(item.id)}>
            Approve plan
          </button>
          <button className="btn small" onClick={() => onOpen(item.taskId, "plan")}>
            See the plan
          </button>
          {sendBack("Re-plan…")}
        </div>
      )}

      {item.kind === "design" && (
        <div className="ask-actions">
          <button className="btn small primary" onClick={() => sim.approve(item.id)}>
            Approve design
          </button>
          <button className="btn small" onClick={() => onOpen(item.taskId, "design")}>
            Read the brief
          </button>
          {sendBack("Request changes…")}
        </div>
      )}

      {item.kind === "disagreement" && (
        <div className="ask-actions">
          <button className="btn small primary" onClick={() => sim.approve(item.id)}>
            Side with the architect
          </button>
          <button className="btn small" onClick={() => onOpen(item.taskId, "design")}>
            Read both sides
          </button>
          {sendBack("Write my call…")}
        </div>
      )}

      {item.kind === "delivery" && (
        <div className="ask-actions">
          <button className="btn small primary" onClick={() => sim.approve(item.id)}>
            <GitPullRequest size={13} />
            Open pull request
          </button>
          <button className="btn small" onClick={() => onOpen(item.taskId, "review")}>
            See the reviews
          </button>
          {sendBack("Send back…")}
        </div>
      )}
    </article>
  );
}
