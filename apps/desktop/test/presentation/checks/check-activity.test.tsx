vi.mock("../../../src/notify/channels", () => {
  const unexpected = () => {
    throw new Error("This presentation test did not request a native notification.");
  };
  return {
    platform: () => "linux",
    browserPermission: () => "unsupported",
    useBrowserPermission: () => "unsupported",
    askBrowser: async () => "unsupported",
    BrowserNotices: class {
      show = unexpected;
      test = unexpected;
      waiting() {}
    },
    shell: {
      show: unexpected,
      test: unexpected,
      badge: unexpected,
      onClick: unexpected,
      onRelaunch: unexpected,
    },
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: () => {
    throw new Error("This presentation test did not request a native desktop operation.");
  },
}));
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Simulator, type CheckActivity, type DeepMutable, type State, type Task } from "@petrina/core";
import { App } from "../../../src/App";
import { stateFixture, taskFixture } from "../../fixtures/state";

let simulator: Simulator;
const live = { link: "live", desktop: false };
const empty: never[] = [];
vi.mock("../../../src/engine", () => ({
  mode: "demo",
  desktop: false,
  startClock: () => () => {},
  useEngineStatus: () => live,
  useUnsent: () => empty,
  useSim: () =>
    useSyncExternalStore(
      (fn) => simulator.subscribe(fn),
      () => simulator.getState(),
    ),
  sim: new Proxy(
    {},
    {
      get: (_, name) =>
        name === "synced"
          ? () => true
          : (...args: unknown[]) => (simulator[name as keyof Simulator] as Function).apply(simulator, args),
    },
  ),
}));

const NOW = 1_000_000_000_000;
const QUEUED_AT = NOW - 5 * 60_000;
let root: Root;
let host: HTMLDivElement;
const card = (id: string) => host.querySelector<HTMLElement>(`.card[data-task-id="${id}"]`)!;
const text = (element: Element | null | undefined) => element?.textContent?.trim();
const nowLines = () => [...host.querySelectorAll(".now .now-line")].map((line) => line.textContent);

function waitingState(
  activity: Partial<CheckActivity> = {},
  owners: [string, string[]][] = [["guest-checkout", ["Tests"]]],
): State {
  const state = stateFixture(NOW);
  const productId = state.products[0]!.id;
  const loginTask = taskFixture(state, {
    id: "login-loop",
    productId,
    title: "Fix login loop on Safari",
    state: "running",
    startedAt: QUEUED_AT - 120_000,
    delivery: "pull-request",
    holdsSlot: false,
    stageIndex: 1,
    sub: 0,
    plan: {
      rationale: "Fix and verify Safari login loop",
      plannerProfileId: "sonnet-medium",
      stages: [
        { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
        { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"] },
        { id: "delivery", kind: "gate", title: "Your delivery check", roleId: "release-manager", profileIds: [], gate: "delivery" },
        { id: "ship", kind: "do", title: "Ship", roleId: "release-manager", profileIds: ["sonnet-medium"] },
      ],
    },
  });
  const checkoutTask = taskFixture(state, {
    id: "guest-checkout",
    productId,
    title: "Guest checkout",
    state: "running",
    startedAt: QUEUED_AT - 180_000,
  });
  const pricingTask = taskFixture(state, {
    id: "pricing-refresh",
    productId,
    title: "Refresh the pricing page",
    state: "running",
    startedAt: QUEUED_AT - 200_000,
  });
  state.tasks = [loginTask, checkoutTask, pricingTask];

  const fact: CheckActivity = {
    phase: "waiting",
    productId: loginTask.productId,
    since: QUEUED_AT,
    ahead: 2,
    place: 4,
    slots: 1,
    owners: owners.map(([id]) => ({
      taskId: id,
      title: state.tasks.find((entry) => entry.id === id)!.title,
      kind: "checks" as const,
    })),
    ...activity,
  };
  loginTask.checkActivity = fact as DeepMutable<CheckActivity>;
  loginTask.statusLine =
    activity.phase === "held"
      ? "Waiting for checks · held for cleanup"
      : `Waiting for checks · ${fact.ahead === 1 ? "1 run" : `${fact.ahead} runs`} ahead`;
  loginTask.journey = [
    {
      id: "j1",
      kind: "agent",
      roleId: "builder",
      profileId: "sol-high",
      stageId: "build",
      round: 1,
      sub: 0,
      startedAt: QUEUED_AT - 120_000,
      endedAt: QUEUED_AT - 90_000,
      end: "done",
      outcome: "Implemented fix",
    },
    {
      id: "j2",
      kind: "petrina",
      work: "checks",
      stageId: "build",
      round: 1,
      sub: 0,
      startedAt: QUEUED_AT - 80_000,
      endedAt: QUEUED_AT - 60_000,
      end: "done",
      outcome: "All checks pass",
      productChecks: [
        {
          id: "check-prev",
          attemptId: "run-0",
          productId: loginTask.productId,
          name: "Tests",
          result: "pass",
          startedAt: QUEUED_AT - 80_000,
          endedAt: QUEUED_AT - 60_000,
        },
      ],
    },
    {
      id: "j3",
      kind: "petrina",
      work: "checks",
      stageId: "review",
      round: 1,
      sub: 0,
      startedAt: QUEUED_AT,
      trigger: { reason: "Review passed" },
      productChecks: [
        {
          id: "check-0",
          attemptId: "run-0",
          queuedAt: QUEUED_AT,
          productId: loginTask.productId,
          name: "Tests",
          result: "pending",
        },
      ],
      checkReasons: [
        {
          attemptId: "run-0",
          purpose: "review",
          earlier: { nodeId: "j2", attemptId: "run-0", passed: true, at: QUEUED_AT - 60_000 },
          changed: ["code"],
        },
      ],
    },
  ];
  for (const [id, names] of owners) {
    const holder = state.tasks.find((entry) => entry.id === id)! as DeepMutable<Task>;
    holder.checkActivity = { phase: "running", since: QUEUED_AT - 60_000, slots: fact.slots, running: names };
  }
  return { ...state, pool: { ...state.pool, paused: true } };
}

async function mount(state: State) {
  simulator = new Simulator(state);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<App />));
}
async function open(id: string) {
  await act(async () => card(id).querySelector<HTMLButtonElement>(".card-open")!.click());
}

beforeEach(() => localStorage.clear());
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("a task waiting in the check line", () => {
  it("keeps one calm line on its card and names Checks as the current mark before Review", async () => {
    await mount(waitingState());
    expect(text(card("login-loop").querySelector(".card-status"))).toBe("Waiting for checks · 2 runs ahead");
    const current = card("login-loop").querySelector<HTMLElement>(".pipeline li.current")!;
    expect(text(current.querySelector(".name"))).toBe("Checks");
    expect(current.getAttribute("aria-label")).toBe("Automated checks before Review, now");
    expect(current.dataset.tip).toBe("Automated checks before Review, now");
    expect(current.tabIndex).toBe(0);
    expect([...card("login-loop").querySelectorAll(".pipeline li")].map((mark) => mark.getAttribute("aria-label"))).not.toContain(
      "Review, now",
    );
    expect(card("login-loop").querySelectorAll(".card-status")).toHaveLength(1);
  });

  it("says what it waits for in Right now, with the running owner linked and no time estimate", async () => {
    await mount(waitingState());
    await open("login-loop");
    expect(text(host.querySelector(".now .who"))).toBe("Automated checks");
    expect(text(host.querySelector(".now .what"))).toBe("Waiting for checks · 2 runs ahead");
    expect(nowLines()).toContain("Tests for “Guest checkout” is running");
    expect(nowLines()).toContain("Checks have their own line, separate from agent slots.");
    expect(nowLines().some((line) => line?.startsWith("Next: code review"))).toBe(true);
    const link = [...host.querySelectorAll<HTMLAnchorElement>(".now .now-line a")].find(
      (anchor) => anchor.textContent === "“Guest checkout”",
    )!;
    expect(link.getAttribute("href")).toContain("guest-checkout");
    expect(host.querySelector(".now")!.textContent).not.toMatch(/minutes? left|starts at|Between stages/);
    await act(async () => link.click());
    expect(text(host.querySelector(".sheet h1, .sheet h2, [role='dialog'] h1"))).toBeDefined();
  });

  it("counts down at once when a run ahead leaves, without anyone starting early", async () => {
    await mount(waitingState());
    await open("login-loop");
    await act(async () => {
      simulator = new Simulator(waitingState({ ahead: 1, place: 3 }));
      root.render(<App />);
    });
    await open("login-loop");
    expect(text(host.querySelector(".now .what"))).toBe("Waiting for checks · 1 run ahead");
    expect(text(card("login-loop").querySelector(".card-status"))).toBe("Waiting for checks · 1 run ahead");
  });

  it("names every running owner and the separate limit when two runs may run at once", async () => {
    await mount(
      waitingState({ slots: 2, ahead: 1, place: 4 }, [
        ["guest-checkout", ["Tests"]],
        ["pricing-refresh", ["Lint"]],
      ]),
    );
    await open("login-loop");
    expect(nowLines()).toContain("Running now: Tests for “Guest checkout”; Lint for “Refresh the pricing page”");
    expect(nowLines()).toContain(
      "Checks have their own line, separate from agent slots. Petrina runs up to 2 check runs at once.",
    );
    expect(host.querySelectorAll(".now .now-line a")).toHaveLength(2);
  });

  it("reads held cleanup apart from a healthy run, with the recorded explanation", async () => {
    const detail =
      "Petrina cannot verify whether programs using the saved client process group belong to this run; they may be unrelated. Do not stop programs based on the saved number.";
    await mount(
      waitingState(
        {
          phase: "held",
          ahead: 0,
          place: 2,
          owners: undefined,
          holds: [
            {
              kind: "cleanup",
              owner: { taskId: "guest-checkout", title: "Guest checkout", kind: "extra", name: "Linux suite" },
              detail,
            },
          ],
        },
        [],
      ),
    );
    expect(text(card("login-loop").querySelector(".card-status"))).toBe("Waiting for checks · held for cleanup");
    await open("login-loop");
    expect(nowLines()).toContain(
      `Checks are held until Petrina confirms extra validation “Linux suite” for “Guest checkout” has stopped. ${detail}`,
    );
    expect(nowLines().some((line) => line?.includes("is running"))).toBe(false);
  });

  it("shows the queued run as waiting in its check details, with why it runs and the earlier run kept as history", async () => {
    await mount(waitingState());
    await open("login-loop");
    const task = simulator.getState().tasks.find((entry) => entry.id === "login-loop")!;
    const step = task.journey!.at(-1)!;
    await act(async () => host.querySelector<HTMLElement>(`.journey-list li[data-step-id="${step.id}"]`)!.click());
    const details = host.querySelector(".journey-details")!;
    const clock = new Date(QUEUED_AT).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(details.textContent).toContain("1 check not started yet");
    const timing = text(details.querySelector(".check-attempt p"));
    expect(timing).toContain(`Waiting in the check line since ${clock} · 2 runs ahead`);
    expect(timing).not.toMatch(/Started|so far/);
    expect(details.textContent).toContain("Why these checks run: Before review: the code changed since the passing run in step");
    expect(details.textContent).not.toContain("Review passed");
  });

  it("returns to the review on the strip and in Right now once its reviewer starts", async () => {
    const state = waitingState();
    const task = state.tasks.find((entry) => entry.id === "login-loop")! as DeepMutable<Task>;
    delete task.checkActivity;
    task.agent = { roleId: "code-reviewer", profileId: task.plan!.stages[task.stageIndex]!.profileIds[0]!, since: NOW, step: 0 };
    task.statusLine = "Code reviewer is starting";
    await mount(state);
    const current = card("login-loop").querySelector<HTMLElement>(".pipeline li.current")!;
    expect(current.getAttribute("aria-label")).toBe("Review, now");
    await open("login-loop");
    expect(text(host.querySelector(".now .who"))).toBe("Code reviewer is working");
  });

  for (const taskOwned of [false, true]) {
    it(`names check preparation in Right now with a ${taskOwned ? "task-owned" : "configured"} discovery role`, async () => {
      const state = waitingState({ phase: "preparing", owners: undefined, ahead: undefined, place: undefined }, []);
      const task = state.tasks.find((entry) => entry.id === "login-loop")! as DeepMutable<Task>;
      const configured = state.roles.find((entry) => entry.result === "check-discovery")!;
      const role = taskOwned ? { ...configured, id: "task-checks", name: "Product guide" } : configured;
      const maintenance: NonNullable<Task["maintenance"]> = {
        routineId: "check-preparation",
        routineName: "Prepare checks",
        scheduledAt: NOW,
        queuedAt: NOW,
        zone: "UTC",
        focus: "Prepare checks",
        role,
        profile: state.profiles.find((entry) => entry.id === "sol-high")!,
        input: "",
        product: state.products.find((entry) => entry.id === task.productId)!,
      };
      if (taskOwned) task.maintenance = JSON.parse(JSON.stringify(maintenance));
      task.agent = { roleId: role.id, profileId: "sol-high", since: NOW, step: 0 };
      task.statusLine = "Working out how to check this product";
      await mount(state);
      expect(card("login-loop").querySelector(".pipeline li.current")!.getAttribute("aria-label")).toBe(
        "Automated checks before Review, now",
      );
      await open("login-loop");
      expect(text(host.querySelector(".now .who"))).toBe("Automated checks");
    });
  }

  it("keeps the screen request ahead of the check-preparation heading", async () => {
    const state = waitingState({ phase: "preparing", owners: undefined, ahead: undefined, place: undefined }, []);
    const task = state.tasks.find((entry) => entry.id === "login-loop")! as DeepMutable<Task>;
    const role = state.roles.find((entry) => entry.result === "check-discovery")!;
    task.state = "needs-you";
    task.screen = { reason: "Inspect the product", at: NOW, roleId: role.id, profileId: "sol-high" };
    state.pool.screen = { mode: "off" };
    await mount(state);
    await open("login-loop");
    expect(text(host.querySelector(".now .who"))).toBe(`${role.name} needs the screen. Waiting for your OK`);
  });

  it("keeps requested testing in Next after two refreshes when the checked task version changed", async () => {
    const state = waitingState();
    const task = state.tasks.find((entry) => entry.id === "login-loop")! as DeepMutable<Task>;
    const gate = task.plan!.stages.findIndex((stage) => stage.kind === "gate" && stage.gate === "delivery");
    task.plan!.stages.splice(gate, 0, { id: "final-test", title: "Test", kind: "do", roleId: "tester", profileIds: ["sol-high"] });
    task.stageIndex = gate + 1;
    task.testedPatch = "earlier";
    task.acceptancePassed = false;
    task.acceptanceUnverified = true;
    task.brief = {
      summary: "",
      areas: [],
      forUsers: [],
      risks: [],
      acceptance: [{ text: "Recovery works", verification: "blocked" }],
    };
    task.proofRefreshes = 2;
    task.proofRefreshBlocked = true;
    task.proofRequests = [
      {
        id: "proof",
        source: "review:1:0:0",
        text: "Recovery proof",
        reason: "Final version proof",
        productIds: [task.productId],
        ownerStageId: "final-test",
        reviewedVersions: {},
        status: "pending",
        requestedBy: {
          stageId: "review",
          round: 1,
          seat: "0",
          roleId: "code-reviewer",
          profileId: "sol-high",
        },
      },
    ];
    task.checkedProofDecision = {
      refreshBlocked: true,
      versions: { [task.productId]: "earlier-main-only-version" },
      statuses: { proof: "pending" },
    };
    task.checks = { current: true, sha: "checked", tree: "changed-task-version", at: NOW, results: [] };
    task.checkedSha = "checked";
    task.checkedPatch = "changed-task-patch";
    task.testedChanges = { [task.productId]: "earlier-task-patch" };
    task.testedVersions = { [task.productId]: "earlier-main-only-version" };
    await mount(state);
    await open("login-loop");
    expect(nowLines()).toContain("Next: final acceptance testing for requested proof, then your OK to ship");
  });
});
