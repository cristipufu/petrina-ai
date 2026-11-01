import { Select } from "./Select";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronRight, FolderGit2 } from "lucide-react";
import { DELIVERY_LABEL, SETUP_STEPS, STARTER_IDEAS, toolsGate, type Clone, type DeliveryMode, type SetupStep, type State, type TaskKind } from "@petrina/core";
import { failureText, Late, Lost, mode, newClientId, plainReason, sim, type EngineStatus } from "../engine";
import { ago } from "../lib";
import { Logo } from "./bits";
import { EngineRecovery } from "./EngineState";
import { TaskOptions, taskKindLabel } from "./NewTask";
import { CheckAgain, shownChecks, ToolList, useCheckOnEnter } from "./Tools";

// First run: four short screens in one window. Welcome, Tools, Product, First task. It shows only
// once the engine's real state says setup is not done, so someone who already uses Petrina never
// sees it. It stays on screen through a lost connection, with everything typed, and carries on.

// The demo's first run keeps its own draft: opening the demo, or trying its first run, never touches
// a first task still being written for the real engine.
const DRAFT_KEY = mode === "demo" ? "petrina.demo.firstTask" : "petrina.firstTask";

/** The first task as typed so far. Kept on this machine until the engine confirms it saved the task. */
interface Draft {
  productId?: string;
  title: string;
  description: string;
  approvePlan: boolean;
  kind: TaskKind;
  /** Unset: what the product does. */
  delivery?: DeliveryMode;
  approveDelivery?: boolean;
  /** Made at the first Start and kept until the task is saved: a retry is the same request, never a second card. */
  clientId?: string;
}

const NEW_DRAFT: Draft = { title: "", description: "", approvePlan: true, kind: "feature" };

function loadDraft(): Draft {
  try {
    const saved = localStorage.getItem(DRAFT_KEY);
    return saved ? { ...NEW_DRAFT, ...(JSON.parse(saved) as Partial<Draft>) } : NEW_DRAFT;
  } catch {
    return NEW_DRAFT;
  }
}

function saveDraft(draft: Draft): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Without storage the draft still stays on screen; it just does not outlive the window.
  }
}

export function clearFirstTaskDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Where first run reopens: the furthest screen reached, past Product once a product is there, back to it when none is. */
function resumeAt(state: State): SetupStep {
  const step = state.setup?.step ?? "welcome";
  if (step === "product" && state.products.length > 0) return "task";
  if (step === "task" && state.products.length === 0) return "product";
  return step;
}

/** A home folder written as ~, so paths stay short. */
function short(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, "~");
}

export function FirstRun({ state, status }: { state: State; status: EngineStatus }) {
  const [screen, setScreen] = useState<SetupStep>(() => resumeAt(state));
  const [clones, setClones] = useState<Clone[]>();
  const live = status.link === "live";
  const index = SETUP_STEPS.findIndex((step) => step.id === screen);

  const go = (next: SetupStep) => {
    setScreen(next);
    sim.setSetupStep(next);
  };
  const back = index > 0 ? () => setScreen(SETUP_STEPS[index - 1]!.id) : undefined;

  // Connected: check the tools and look for clones in the background, so each screen is ready when
  // it is reached. Again after a lost connection comes back.
  useEffect(() => {
    if (!live) return;
    void sim.checkTools();
    let current = true;
    Promise.resolve(sim.findClones()).then(
      (found) => current && setClones(found),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [live]);

  return (
    <div className="first-run">
      <header className="setup-bar">
        <div className="brand" aria-label="Petrina">
          <Logo />
          Petrina
        </div>
        <ol className="setup-steps" aria-label="Setup steps">
          {SETUP_STEPS.map((step, at) => (
            <li key={step.id} className={at < index ? "done" : at === index ? "current" : ""} aria-current={at === index ? "step" : undefined}>
              <span className="mark" aria-hidden="true">
                {at < index ? <Check size={12} strokeWidth={3} /> : at + 1}
              </span>
              {step.label}
              {at < index && <span className="sr-only">, done</span>}
            </li>
          ))}
        </ol>
        <button
          className="btn quiet"
          onClick={() => sim.skipSetup()}
          disabled={!live}
          title={live ? "Go straight to the board. Setup won't come back." : "Petrina is reconnecting"}
        >
          Skip setup
        </button>
      </header>

      {!live && (
        <p className="setup-banner" role="status">
          <span className="dot needs-you" aria-hidden="true" />
          Reconnecting to Petrina's engine. Everything you typed stays here, and setup carries on when it's back.
        </p>
      )}
      {/* A browser window can't start the engine itself: after a few seconds it says how, as the board does. */}
      {!live && !status.desktop && status.recovery && <EngineRecovery status={status} />}

      <main className="setup-main">
        <section className="setup-card" aria-labelledby="setup-title">
          {screen === "welcome" && <Welcome onNext={() => go("tools")} />}
          {screen === "tools" && <Tools state={state} onBack={back} onNext={() => go("product")} />}
          {screen === "product" && <ProductStep state={state} clones={clones} live={live} onBack={back} onNext={() => go("task")} />}
          {screen === "task" && <FirstTask state={state} onBack={back} />}
        </section>
      </main>
    </div>
  );
}

/** Back on the left, the screen's one main action on the right. */
function Actions({ onBack, children }: { onBack: (() => void) | undefined; children: ReactNode }) {
  return (
    <div className="setup-actions">
      {onBack && (
        <button className="btn quiet" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" />
          Back
        </button>
      )}
      <span className="grow" />
      {children}
    </div>
  );
}

/** A screen's title takes focus when the screen opens, so keyboards and screen readers start at the top. */
function Title({ children, focus = true }: { children: ReactNode; focus?: boolean }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <h1 ref={ref} id="setup-title" tabIndex={-1}>
      {children}
    </h1>
  );
}

function Welcome({ onNext }: { onNext: () => void }) {
  const start = useRef<HTMLButtonElement>(null);
  const next = useRef(onNext);
  next.current = onNext;
  useEffect(() => {
    start.current?.focus();
    // Enter starts from anywhere on this screen.
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === "Enter" && !["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        event.preventDefault();
        next.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="welcome">
      <span className="setup-mark">
        <Logo size={56} />
      </span>
      <Title focus={false}>Welcome to Petrina</Title>
      <p className="setup-lead">Petrina runs a squad of AI agents on your products. You set priorities and make the calls.</p>
      <p className="quiet">Everything runs on this machine, with the coding tools you're already logged into.</p>
      <div className="setup-actions center">
        <button ref={start} className="btn lead big" onClick={onNext}>
          Get started
        </button>
      </div>
    </div>
  );
}

function Tools({ state, onBack, onNext }: { state: State; onBack: (() => void) | undefined; onNext: () => void }) {
  useCheckOnEnter(true);
  const checks = state.setup?.checks ?? [];
  const gate = toolsGate(checks);
  return (
    <>
      <Title>Your tools</Title>
      <p className="setup-lead">Petrina's agents work with the coding tools you already use. This is what it found on this machine.</p>
      <ToolList checks={shownChecks(checks)} platform={state.setup?.platform ?? "darwin"} />
      <div className="setup-row">
        <CheckAgain checks={checks} />
        <span className="quiet">Ran a fix? Come back to this window and Petrina checks again by itself.</span>
      </div>
      {gate.notes.length > 0 && (
        <ul className="setup-notes">
          {gate.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <Actions onBack={onBack}>
        {!gate.ok && gate.missing && (
          <p className="setup-missing" id="tools-missing" role="status">
            {gate.missing}
          </p>
        )}
        <button className="btn lead" onClick={onNext} disabled={!gate.ok} aria-describedby={gate.ok ? undefined : "tools-missing"}>
          Continue
        </button>
      </Actions>
    </>
  );
}

function ProductStep({ state, clones, live, onBack, onNext }: {
  state: State;
  clones: Clone[] | undefined;
  live: boolean;
  onBack: (() => void) | undefined;
  onNext: () => void
}) {
  const [path, setPath] = useState("");
  const [adding, setAdding] = useState<string>();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string>();
  const [added, setAdded] = useState<string>();
  const busy = useRef(false);
  const product = state.products.find((entry) => entry.id === added);
  const found = (clones ?? []).filter((clone) => !state.products.some((entry) => entry.repo === clone.repo || entry.path === clone.path));
  // A clone not linked to GitHub stays here a moment, to say where its work goes. Any other moves on.
  const local = product?.delivery === "local";

  const next = useRef(onNext);
  next.current = onNext;
  useEffect(() => {
    if (product && !local) next.current();
  }, [product, local]);

  const add = async (target: string) => {
    if (busy.current || !target.trim()) return;
    busy.current = true;
    setAdding(target);
    setError(undefined);
    try {
      const before = sim.getState().products;
      const id = String(await sim.addProduct(target.trim()));
      // Already added: it says so and stays here, with Continue below.
      const already = before.find((entry) => entry.id === id);
      if (already) setError(`${already.name} is already added.`);
      else setAdded(id);
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      busy.current = false;
      setAdding(undefined);
    }
  };

  const chooseFolder = async () => {
    if (busy.current || picking || !live) return;
    setPicking(true);
    setError(undefined);
    try {
      const chosen = await sim.pickFolder();
      if (!chosen) return;
      setPath(chosen);
      await add(chosen);
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setPicking(false);
    }
  };

  const earlier = state.products.filter((entry) => entry.id !== added);

  return (
    <>
      <Title>Add your first product</Title>
      <p className="setup-lead">Pick a GitHub project on this machine. Each task gets its own working copy, so your folder stays untouched.</p>

      {local && product ? (
        <div className="setup-added" role="status">
          <p>
            <strong>{product.name}</strong> is added, and since it isn't linked to GitHub, its finished work stays on this machine instead of becoming a pull request.
          </p>
        </div>
      ) : (
        <>
          {clones === undefined ? (
            <p className="quiet" role="status">
              Looking for GitHub projects in your usual code folders…
            </p>
          ) : found.length === 0 ? (
            <p className="quiet">
              Petrina didn't find GitHub projects in your usual code folders. Choose a folder or paste its path below.
            </p>
          ) : (
            <ul className="clone-list" aria-label="GitHub projects on this machine">
              {found.map((clone) => (
                <li key={clone.path}>
                  <button className="clone" onClick={() => void add(clone.path)} disabled={!!adding || !live} aria-busy={adding === clone.path}>
                    <FolderGit2 size={20} aria-hidden="true" />
                    <span className="clone-name">{clone.repo.split("/")[1]}</span>
                    <span className="clone-where">
                      {clone.repo} · {short(clone.path)} · changed {ago(
                        clone.changedAt,
                        state.now
                      ) === "now" ? "just now" : `${ago(
                        clone.changedAt,
                        state.now
                      )} ago`}
                    </span>
                    {adding === clone.path && <span className="clone-adding">Adding…</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form
            className="paste"
            onSubmit={(event) => {
              event.preventDefault();
              void add(path);
            }}
          >
            <label htmlFor="setup-path">
              {found.length ? "Or choose or paste the folder of a clone" : "Folder of a clone"}
            </label>
            <div className="paste-row">
              <input
                id="setup-path"
                className="field"
                placeholder="~/code/my-product"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              <button
                className="btn"
                type="button"
                onClick={() => void chooseFolder()}
                disabled={picking || !!adding || !live}
              >
                {picking ? "Choosing…" : "Choose folder…"}
              </button>
              <button className="btn" type="submit" disabled={!path.trim() || picking || !!adding || !live}>
                {adding === path ? "Adding…" : "Add"}
              </button>
            </div>
          </form>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          {earlier.length > 0 && <p className="quiet">Already added: {earlier.map((entry) => entry.name).join(", ")}.</p>}
        </>
      )}

      <Actions onBack={onBack}>
        {(local || earlier.length > 0) && (
          <button className="btn lead" onClick={onNext}>
            Continue
          </button>
        )}
      </Actions>
    </>
  );
}

function FirstTask({ state, onBack }: { state: State; onBack: (() => void) | undefined }) {
  const [draft, setDraftState] = useState<Draft>(loadDraft);
  const [more, setMore] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const setDraft = (change: Partial<Draft>) =>
    setDraftState((before) => {
      const next = { ...before, ...change };
      saveDraft(next);
      return next;
    });

  // The product is already picked: the one added last, unless the coordinator chose another.
  const productId = draft.productId && state.products.some((entry) => entry.id === draft.productId) ? draft.productId : state.products.at(-1)?.id;
  const product = state.products.find((entry) => entry.id === productId);
  const delivery = draft.delivery ?? product?.delivery ?? "pull-request";
  const approveDelivery = draft.approveDelivery ?? product?.approveDelivery ?? true;
  const lengthProblem = draft.title.length > 200
    ? "Shorten the task title to 200 characters or fewer."
    : draft.description.length > 8000 ? "Shorten the details to 8,000 characters or fewer." : undefined;
  const missing = !draft.title.trim() ? "Write what you want done, or pick an idea." : undefined;
  const ready = !missing && !lengthProblem && !!productId;
  const summary = `${taskKindLabel(draft.kind)} · ${DELIVERY_LABEL[delivery]} · ${approveDelivery ? "Asks before shipping" : "Ships without asking"}`;

  useEffect(() => titleRef.current?.focus(), []);

  const start = async () => {
    if (busy.current || !ready) return;
    busy.current = true;
    setStarting(true);
    setError(undefined);
    const clientId = draft.clientId ?? newClientId();
    if (!draft.clientId) setDraft({ clientId });
    try {
      await sim.startFirstTask({
        productId: productId!,
        title: draft.title.trim(),
        description: draft.description.trim(),
        kind: draft.kind,
        position: "bottom",
        approvePlan: draft.approvePlan,
        delivery,
        approveDelivery,
        clientId
      });
      // Saved: the board takes over as soon as the engine's state says setup is done. Until then this stays as it is.
      clearFirstTaskDraft();
    } catch (failure) {
      setError(
        failure instanceof Lost
          ? "Petrina lost its connection before the task was saved, so nothing is lost: try again once it's back."
          : failure instanceof Late
            ? "Petrina didn't confirm the task within 10 seconds, so try again: it won't be added twice."
            : `Petrina couldn't save the task: ${plainReason(failure instanceof Error ? failure.message : String(failure)).replace(/\.$/, "")}.`,
      );
      busy.current = false;
      setStarting(false);
    }
  };

  return (
    <>
      <Title focus={false}>Your first task</Title>
      <p className="setup-lead">Write it the way you'd say it to a teammate. The squad plans it, builds it and has it reviewed.</p>

      <div className="task-form task-request-fields">
        {state.products.length > 1 ? (
          <label className="product-pick setup-product">
            <span>Product</span>
            <Select
              className="select"
              value={productId}
              onChange={(event) => setDraft({
              productId: event.target.value,
              delivery: undefined,
              approveDelivery: undefined
            })}
              disabled={starting}
            >
              {state.products.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </Select>
          </label>
        ) : (
          product && (
            <div className="product-pick setup-product"><span>Product</span><strong>{product.name}</strong></div>
          )
        )}
        <label htmlFor="first-task-title">What do you want done?</label>
        <input
          id="first-task-title"
          maxLength={200}
          aria-describedby={lengthProblem && draft.title.length > 200 ? "first-task-length" : undefined}
          ref={titleRef}
          className="title-input"
          aria-label="What do you want done?"
          placeholder="A short, specific task title"
          value={draft.title}
          readOnly={starting}
          onChange={(event) => setDraft({ title: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void start();
            }
          }}
        />
        <p className="quiet starter-intro" id="starter-ideas">Not sure where to start? Try one of these small tasks:</p>
        <div className="ideas" role="group" aria-labelledby="starter-ideas">
          {STARTER_IDEAS.map((idea) => (
            <button
              key={idea}
              className={`idea ${draft.title === idea ? "on" : ""}`}
              disabled={starting}
              onClick={() => {
                setDraft({ title: idea });
                titleRef.current?.focus();
              }}
            >
              {idea}
            </button>
          ))}
        </div>
        <label htmlFor="first-task-details">Details <span className="quiet-text">Optional</span></label>
        <textarea
          id="first-task-details"
          maxLength={8000}
          rows={4}
          aria-describedby={lengthProblem && draft.description.length > 8000 ? "first-task-length" : undefined}
          className="details"
          aria-label="Details"
          placeholder="What should change? Add context, links and how you’ll judge success."
          value={draft.description}
          readOnly={starting}
          onChange={(event) => setDraft({ description: event.target.value })}
        />
        <div className="first-task-plan">
          <label className="toggle">
            <input type="checkbox" checked={draft.approvePlan} disabled={starting} onChange={(event) => setDraft({ approvePlan: event.target.checked })} />
            Show me the plan first
          </label>
          <p className="quiet toggle-hint">{draft.approvePlan ? "You'll see the squad's plan and approve it before anyone starts work." : "The squad starts as soon as the plan is ready."}</p>
        </div>
        <div className="first-task-more">
          <button
            className="fold"
            disabled={starting}
            aria-describedby={!more ? "first-task-summary" : undefined}
            aria-expanded={more}
            onClick={() => setMore((on) => !on)}
          >
            {more ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
            More options
          </button>
          {!more && <span className="quiet" id="first-task-summary">{summary}</span>}
        </div>
        {more && (
          <div className="more-options">
            <TaskOptions
              kind={draft.kind}
              delivery={delivery}
              position="bottom"
              hidePosition
              showKindDescription
              onKind={(kind) => setDraft({ kind })}
              onDelivery={(value) => setDraft({ delivery: value })}
              onPosition={() => {}}
              disabled={starting}
            />
            <label className="toggle">
              <input type="checkbox" checked={approveDelivery} disabled={starting} onChange={(event) => setDraft({ approveDelivery: event.target.checked })} />
              Ask me before shipping
            </label>
          </div>
        )}
      </div>

      {error && (
        <div className="setup-error" role="alert">
          <p>{error}</p>
          <button className="btn" onClick={() => void start()}>
            Try again
          </button>
        </div>
      )}

      {lengthProblem && <p className="error-text" id="first-task-length" role="alert">{lengthProblem}</p>}
      <Actions onBack={starting ? undefined : onBack}>
        {missing && !starting && <p className="setup-missing" id="first-task-missing">{missing}</p>}
        <button
          className="btn lead big"
          onClick={() => void start()}
          disabled={!ready || starting}
          aria-busy={starting}
          aria-describedby={!starting ? lengthProblem ? "first-task-length" : missing ? "first-task-missing" : undefined : undefined}
        >
          {starting ? "Starting…" : "Start task"}
        </button>
      </Actions>
    </>
  );
}
