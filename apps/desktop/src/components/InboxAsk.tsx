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
  Scale,
  ShieldQuestion,
  SquareTerminal,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import {
  CHECK_NAMES,
  checkOf,
  describeInboxCardHeader,
  fixFor,
  wontStartFix,
  type InboxItem,
  type InboxKind,
  type State,
} from "@petrina/core";
import { sim, useEngineStatus, useUnsent } from "../engine";
import { ago, type Lookup } from "../lib";
import { ProductName, ProfileText, RoleAvatar } from "./bits";
import { UnsentNote } from "./EngineState";
import { ASK_RENDERERS } from "./inbox/AskActions";
import type { SheetTab } from "./TaskCard";
import { FixSteps } from "./Tools";

const ASK_ICONS: Readonly<Record<InboxKind, LucideIcon>> = {
  "maintenance-settings": TriangleAlert,
  question: CircleHelp,
  permission: ShieldQuestion,
  plan: MapIcon,
  design: Compass,
  disagreement: Scale,
  delivery: GitPullRequest,
  stuck: TriangleAlert,
  shipping: PackageSearch,
  driving: SquareTerminal,
  guide: BookOpen,
  learnings: Lightbulb,
  screen: Monitor,
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
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
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
  const header = describeInboxCardHeader(item, task);
  const Icon = ASK_ICONS[item.kind];
  const ActionRenderer = ASK_RENDERERS[item.kind];
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
      <div className={`ask-kind tone-${header.tone}`}>
        <Icon size={14} strokeWidth={2.3} aria-hidden="true" />
        <span>
          {header.label}{" "}
          <span className="when num">
            · {ago(item.at, state.now) === "now" ? "just now" : `${ago(item.at, state.now)} ago`}
          </span>
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
        item.body &&
        (item.kind === "learnings" ? (
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

      <ActionRenderer
        item={item}
        task={task}
        sending={sending}
        lessons={lessons}
        kept={kept}
        onOpen={onOpen}
        sendBack={sendBack}
      />
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
