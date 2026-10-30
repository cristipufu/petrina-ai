// Scripted responses and believable tool reports for the offline demos. No engine bookkeeping.
import { callOn } from "./call.js";
import type { DeepMutable } from "./flow.js";
import type { CheckExecutorFacts, CheckRun, DesignBrief, Id, Product, Role, Task, TaskKind } from "./model.js";
import type { TaskSource, WorkChoice } from "./source.js";
import type { TurnReport } from "./worklog.js";
import type { SimQuirk } from "./sim-types.js";
import { taskProductIds } from "./repositories.js";
import { commandText } from "./check-commands.js";
export { callAnswers, readCall } from "./sim-call-reader.js";

/** Opaque offline-model identities, not cryptographic hashes or observed native source identities. */
function modeledIdentity(value: unknown): string {
  const text = JSON.stringify(value);
  return Array.from({ length: 8 }, (_, lane) => hash(`offline-demo:${lane}:${text}`).toString(16).padStart(8, "0")).join("");
}

/** Stable synthetic contents, changed only by a completed demo build. */
export function simVersions(task: Task, buildStep?: Id): Record<Id, string> {
  return Object.fromEntries(taskProductIds(task).map(id => {
    const recorded = task.journey?.findLast(step => step.buildVersions?.[id])?.buildVersions?.[id];
    return [id, buildStep ? modeledIdentity(["version", task.id, id, buildStep])
      : recorded ? /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(recorded) ? recorded : modeledIdentity(["legacy-version", recorded])
      : modeledIdentity(["version", task.id, id, "initial"])];
  }));
}

/** Only a simulated completed check run creates these explicitly modeled observations; no argv is executed. */
export function simCheckSetup(product: Pick<Product, "id" | "checks" | "checkSetup">, tree: string, at: number,
  ids: { before: Id; after: Id }, invalidationId?: Id) {
  const executor: CheckExecutorFacts = { version: 1, adapter: "offline-demo-simulation", contract: 1, launchPolicy: 1,
    platform: "simulated", architecture: "simulated", osRelease: "simulated", runtime: { name: "simulated", version: "1" } };
  const requirements = (product.checkSetup?.requirements ?? []).map(requirement => ({ ...requirement, argv: [...requirement.argv] }));
  const contract = modeledIdentity(["setup", product.checkSetup?.revision ?? "undeclared", requirements]);
  const input = { tree, definition: modeledIdentity(["commands", product.checks, DEMO_CHECKS.map(run => [run.name, run.command])]), contract,
    ...(invalidationId ? { invalidationId } : {}) };
  const empty = { algorithm: "sha256" as const, bytes: 0, digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" };
  const identity = { version: 1 as const, contract, executor: modeledIdentity(["executor", executor]),
    prerequisites: requirements.length ? {
      kind: "declared" as const,
      observations: modeledIdentity([
      "empty-modeled-output",
      requirements.map(requirement => requirement.id)
    ])
    } : { kind: "none" as const } };
  const attempt = (position: "before-checks" | "after-checks", id: Id) => ({ id, productId: product.id, queuedAt: at, startedAt: at, endedAt: at,
    lifecycle: "settled" as const, position, input: { ...input }, requirements: requirements.map(requirement => ({
      ...requirement,
      argv: [...requirement.argv]
    })), executor,
    results: requirements.map(requirement => ({ requirementId: requirement.id, run: { name: requirement.name, command: commandText(requirement.argv), ok: true, ms: 0, output: "",
      execution: { started: true, exit: {
        status: "reported" as const,
        code: 0
      }, stdout: "eof" as const, stderr: "eof" as const, timedOut: false, cancelled: false,
        cleanup: "not-requested" as const, outputCleanup: "not-requested" as const }, executor, outputIdentity: {
          stdout: { ...empty },
          stderr: { ...empty }
        } } })),
    afterInput: { ...input, trackedChanged: false }, restoration: "unchanged" as const, identity });
  return { before: attempt("before-checks", ids.before), after: attempt("after-checks", ids.after), executor,
    input, environment: { ...identity, setupAttempts: { ...ids } } };
}

export function simAcceptance(task: Task) {
  return (task.brief?.acceptance ?? []).map((item) => ({ text: item.text, result: "pass" as const,
    evidence: `Demo scenario: ${item.text}. The simulated user flow met this requirement.`,
    productIds: item.productIds ?? taskProductIds(task),
  }));
}

export const DEMO_RISK: Record<TaskKind, { level: "low" | "medium" | "high"; why: string }> = {
  new: { level: "high", why: "A new product: everything it touches is new, sign-in included." },
  feature: { level: "medium", why: "New behaviour in one part of the product." },
  bug: { level: "medium", why: "A fix to how people sign in and pay, in one place." },
  chore: { level: "low", why: "Only words and styles change: nothing can be lost or opened up." },
};
/** Scripted completed-check observations for offline demos, never loaded execution evidence. */
export const DEMO_CHECKS: CheckRun[] = [
  {
    name: "Type check",
    command: "bun run typecheck",
    ok: true,
    execution: {
    started: true,
    exit: {
    status: "reported",
    code: 0
  },
    stdout: "eof",
    stderr: "eof",
    timedOut: false,
    cancelled: false,
    cleanup: "not-requested",
    outputCleanup: "not-requested"
  },
    ms: 9_000,
    output: "No errors."
  },
  {
    name: "Tests",
    command: "bun run test",
    ok: true,
    execution: {
    started: true,
    exit: {
    status: "reported",
    code: 0
  },
    stdout: "eof",
    stderr: "eof",
    timedOut: false,
    cancelled: false,
    cleanup: "not-requested",
    outputCleanup: "not-requested"
  },
    ms: 41_000,
    output: "212 pass\n0 fail\nRan 212 tests across 31 files."
  },
  {
    name: "Build",
    command: "bun run build",
    ok: true,
    execution: {
    started: true,
    exit: {
    status: "reported",
    code: 0
  },
    stdout: "eof",
    stderr: "eof",
    timedOut: false,
    cancelled: false,
    cleanup: "not-requested",
    outputCleanup: "not-requested"
  },
    ms: 23_000,
    output: "Built in 22.4s."
  },
];

interface ScriptContext {
  area: string;
  product: string;
  round: number;
  fixing: boolean;
  /** The architect is following the coordinator's call. */
  following: boolean;
  /** The design reviewer keeps objecting every round. */
  objecting: boolean;
}

/** One item of an agent's to-do list, with the actions it takes under it ("Reading the code", "Editing files"). */
type Item = readonly [todo: string, ...actions: string[]];

/** One moment of a scripted agent: it starts the next item of its to-do list, or takes an action under it. */
type Moment = { todo: string } | { action: string };

/** What each role works on, as its own to-do list in plain language, and what it does under each item. */
function itemsFor(role: Role | undefined, ctx: ScriptContext): Item[] {
  const { area, product, round, fixing, following, objecting } = ctx;
  if (role?.added) return role.result === "findings"
    ? [
      [
      "Reading the design and the acceptance checklist",
      "Reading the task",
      "Reading the brief"
    ],
      [
      `Going through the change to ${area}`,
      "Reading the code",
      "Searching the code"
    ],
      [
      "Writing findings",
      "Writing up the review",
      "Findings ready"
    ]
    ]
    : [
      [
      `Reading what the task needs from the ${role.name.toLowerCase()}`,
      "Reading the task",
      "Reading the brief"
    ],
      [
      `Working on ${area}`,
      "Reading the code",
      "Thinking it through"
    ],
      [
      "Writing notes for the squad",
      "Writing up the notes",
      "Notes ready"
    ]
    ];
  switch (role?.id) {
    // Only a release has one: Petrina sets the version and publishes it (see `ship`).
    case "release-manager":
      return [
        ["Reading every commit since the previous release", "Reading the release history", "Reading the changes"],
        ["Grouping the changes: new, improved, fixed", "Thinking it through", "Sorting 12 changes"],
        ["Writing the release notes", "Writing up the changes", "Release notes ready"],
      ];
    case "planner":
      return [
        [
        `Looking at how ${product} is organised`,
        "Reading the code",
        "Searching the code"
      ],
        [
        "Choosing who should work on this",
        "Reading the available roles",
        "Thinking it through"
      ],
        [
        "Writing the plan",
        "Writing up the stages",
        "Plan ready"
      ]
      ];
    case "researcher":
      return [
        [
        `Looking at how other products handle ${area}`,
        "Looking something up",
        "Reading 4 articles"
      ],
        [
        `Collecting what users expect from ${area}`,
        "Reading the research",
        "Thinking it through"
      ],
        [
        "Writing research notes",
        "Writing up the findings",
        "Research notes ready"
      ]
      ];
    case "architect":
      if (following) return [
        [
        "Reading your call",
        "Reading the brief",
        "Reading the objections"
      ],
        [
        `Updating the ${area} flow to follow it`,
        "Thinking it through",
        "Writing the brief"
      ],
        [
        "Answering each open objection",
        "Writing up the answers",
        "Brief follows your call"
      ]
      ];
      return round === 1
        ? [
          [
          `Reading the parts of ${product} this touches`,
          "Reading the code",
          "Searching the code"
        ],
          [
          `Sketching the ${area} flow`,
          "Reading the brief",
          "Thinking it through"
        ],
          [
          "Writing the acceptance checklist",
          "Checking the task",
          "Writing the brief"
        ],
          [
          "Getting the brief ready for review",
          "Checking the brief",
          "Design brief ready for review"
        ]
        ]
        : [
          [
          "Reading the objections",
          "Reading the brief",
          "Reading the code"
        ],
          [
          `Reworking the ${area} flow`,
          "Thinking it through",
          "Writing the brief"
        ],
          [
          "Answering each objection",
          "Writing up the answers",
          "Updated brief ready"
        ]
        ];
    case "design-reviewer":
      return round === 1
        ? [
          [
          "Reading the design brief",
          "Reading the task",
          "Reading the brief"
        ],
          [
          `Looking for gaps in the ${area} flow`,
          "Reading the code",
          "Thinking it through"
        ],
          [
          "Writing objections",
          "Writing up the findings",
          "Objections ready"
        ]
        ]
        : [
          [
          "Reading the updated brief",
          "Reading the brief",
          "Reading the objections"
        ],
          [
          "Checking the answer to each objection",
          "Reading the code",
          "Thinking it through"
        ],
          objecting ? [
          "Writing objections",
          "Writing up the findings",
          "Objections ready"
        ] : [
          "Wrapping up the review",
          "Checking the answers",
          "Nothing blocking left"
        ]
        ];
    case "ux-designer":
      return [
        [
        `Sketching the ${area} screens`,
        "Reading the code",
        "Drawing 3 screens"
      ],
        [
        "Checking contrast, spacing and wording",
        "Reading the brief",
        "Thinking it through"
      ],
        [
        "Writing UI notes",
        "Writing up the screens",
        "UI notes ready"
      ]
      ];
    case "builder":
      return fixing
        ? [
          [
          "Reading the review findings",
          "Reading the brief",
          "Reading the code"
        ],
          [
          "Fixing the blocking issue",
          "Editing files",
          "Running the tests"
        ],
          [
          "Checking the fixes",
          "Ran the tests: 44 passed",
          "Fixes ready for review"
        ]
        ]
        : [
            ["Setting up a fresh working copy", "Reading the task", "Running a command"],
            [`Updating the ${area} screens`, "Reading the code", "Editing 3 files"],
            [`Connecting ${area} to the backend`, "Searching the code", "Editing files"],
            [`Writing tests for ${area}`, "Editing files", "Ran the tests: 42 passed"],
            ["Writing up the change for review", "Reading the changes", "Change ready for review"],
          ];
    case "tester":
      return [
        [
        "Starting the app",
        "Reading the brief",
        "Running a command"
      ],
        [
        `Going through ${area} like a user would`,
        "Checking the screens",
        "Took 4 screenshots"
      ],
        [
        "Checking every acceptance item",
        "Running the checks",
        "Every acceptance check passes"
      ]
      ];
    case "code-reviewer":
      return round === 1
        ? [
          [
          "Reading the design and the acceptance checklist",
          "Reading the task",
          "Reading the brief"
        ],
          [
          "Trying to prove “done” wrong",
          "Reading the code",
          "Running the tests"
        ],
          [
          "Checking no test was weakened or skipped",
          "Reading the changes",
          "Searching the code"
        ],
          [
          "Writing findings",
          "Writing up the review",
          "Findings ready"
        ]
        ]
        : [["Checking the fixes", "Reading the changes", "Reading the code"], ["Re-running the acceptance checks", "Running the tests", "Passed"]];
    default:
      return [["Working", "Reading the task", "Thinking it through"]];
  }
}

/** Every moment of a scripted agent's step, in order. */
export function scriptFor(role: Role | undefined, ctx: ScriptContext): Moment[] {
  return itemsFor(role, ctx).flatMap(([todo, ...actions]): Moment[] => [{ todo }, ...actions.map((action) => ({ action }))]);
}

/** What a design reviewer that keeps objecting raises after the first round. */
export function laterObjections(area: string, round: number): { text: string; blocking: boolean }[] {
  return round === 2
    ? [
        { blocking: true, text: `The updated brief still does not say what people see in ${area} when a step fails.` },
        { blocking: false, text: `Show progress in ${area} so people know how much is left.` },
      ]
    : [
        { blocking: true, text: `The answer for existing accounts adds a confirmation step to ${area} that slows everyone down.` },
        { blocking: false, text: "Consider a short note telling existing users what changed." },
      ];
}

export function briefFor(task: DeepMutable<Task>): DeepMutable<DesignBrief> {
  return {
    summary: callOn(
      task,
      task.stageIndex
    ) ? `How ${task.area} should work after this change, following your call.` : `How ${task.area} should work after this change, agreed by both architects.`,
    forUsers: [`${capitalize(task.area)} works the way the task describes`, "Nothing changes for people who do not use it"],
    areas: [capitalize(task.area), "Settings"],
    acceptance: [
      { text: `A user can complete ${task.area} without help` },
      { text: "Existing users see no difference unless they opt in" },
      { text: "Works on phone-sized screens" },
    ],
    risks: ["Edge cases with very old accounts"],
  };
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function areaFromTitle(title: string): string {
  const words = title.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.slice(-2).join(" ") || "this part";
}

function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

const FULL_MODEL: Record<string, string> = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", fable: "claude-fable-5-1" };

/** Believable token figures for a simulated turn: mostly input reused from the cache, as with the real tools. */
export function simReport(seed: string, toolId: Id, model: string, roleId: Id, workMs: number, quirk: SimQuirk): TurnReport {
  const minutes = Math.max(0.3, workMs / 60_000);
  const jitter = (salt: string) => 0.6 + (hash(`${seed}|${salt}`) % 800) / 1000;
  const heavy = roleId === "builder" ? 1.6 : roleId === "code-reviewer" ? 1.1 : roleId === "planner" ? 0.5 : 0.8;
  const scale = minutes * heavy;
  if (toolId === "codex") {
    const output = Math.round(1000 * scale * jitter("out"));
    const counts = {
      input: Math.round(2800 * scale * jitter("in")),
      cacheRead: Math.round(30_000 * scale * jitter("cache")),
      cacheWrite: 0,
      output,
      reasoning: Math.round(output * 0.4 * jitter("reason"))
    };
    return { main: counts, models: [{ model, counts }] };
  }
  const counts = {
    input: Math.round(900 * scale * jitter("in")),
    cacheRead: Math.round(38_000 * scale * jitter("cache")),
    cacheWrite: Math.round(3400 * scale * jitter("write")),
    output: Math.round(800 * scale * jitter("out"))
  };
  if (quirk.noBreakdown) return { main: counts };
  const main = FULL_MODEL[model] ?? model;
  const helper = quirk.extraModel ?? (roleId === "builder" && hash(seed) % 3 === 0 ? "claude-haiku-5-5" : undefined);
  const models = [{ model: main, counts }];
  if (helper) {
    const share = 0.08 + (hash(`${seed}|helper`) % 100) / 1000;
    models.push({
      model: helper,
      counts: {
      input: Math.round(counts.input * share),
      cacheRead: Math.round(counts.cacheRead * share),
      cacheWrite: Math.round(counts.cacheWrite * share),
      output: Math.round(counts.output * share * 1.5)
    }
    });
  }
  // The main figure counts the main agent loop only, so it is smaller than the breakdown. Petrina never adds the two.
  return { main: { ...counts, output: Math.round(counts.output * 0.9) }, models };
}

/** The demo shows resolved choices without contacting GitHub. */
export function demoSource(product: TaskSource["product"], choice: WorkChoice): TaskSource {
  const branch = choice.startFrom.kind === "branch" ? choice.startFrom.name : choice.startFrom.kind === "pull-request" ? "review-fixes" : product.defaultBranch ?? "main";
  const number = choice.startFrom.kind === "pull-request" ? Number(/(?:pull\/|#)?(\d+)\/?$/.exec(choice.startFrom.value)?.[1] ?? 123) : 0;
  const start: TaskSource["start"] = choice.startFrom.kind === "pull-request" ? {
    kind: "pull-request",
    number,
    url: `https://github.com/${product.repo}/pull/${number}`,
    headRepo: product.repo,
    branch
  } : {
    kind: choice.startFrom.kind,
    branch
  };
  return {
    product,
    start,
    destination: {
    mode: choice.delivery,
    kind: start.kind === "pull-request" ? "update-pr" : choice.delivery === "local" ? "branch" : choice.delivery === "release" ? "release" : "new-pr",
    repo: product.repo,
    branch,
    remote: product.remote
  },
    confirmed: true
  };
}
