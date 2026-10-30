import { describe, expect, it } from "vitest";
import {
  BUILT_IN_ROLES,
  DEFAULT_PROFILES,
  balanced,
  changeRuntimeWait,
  createTaskState,
  currentReport,
  displayTask,
  extraSlot,
  onScreen,
  pastSlowDown,
  pickStarts,
  runtimeWaitHolds,
  screenAllowed,
  screenMode,
  screenNext,
  screenQueue,
  screenReady,
  screenWait,
  slotUses,
  syncRuntimeWait,
  toolCapNow,
  usageCovers,
  validateRuntimeWait,
  validateTaskDependencies,
  type Candidate,
  type DeepMutable,
  type Id,
  type Pool,
  type Product,
  type ScreenMode,
  type SlotUse,
  type State,
  type TaskState,
  type Tool,
  type UsageReport,
} from "../../../src/index.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

function pickOne<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

const SEEDS = Array.from({ length: 32 }, (_, index) => index + 1);

const DEMO_PRODUCTS: readonly Product[] = [
  {
    id: "demo",
    name: "Demo",
    repo: "acme/demo",
    tone: "blue",
    defaultBranch: "main",
    delivery: "local",
    approveDelivery: false,
  },
];

function hasActiveCycle(nodes: ReadonlyMap<Id, TaskState>): boolean {
  const visiting = new Set<Id>();
  const visited = new Set<Id>();
  const visit = (id: Id): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    const node = nodes.get(id);
    if (!node || node.state === "done" || node.state === "cancelled") {
      visited.add(id);
      return false;
    }
    visiting.add(id);
    const edges = [...(node.after ?? []), ...(runtimeWaitHolds(node) ? node.runtimeWait!.after : [])];
    for (const target of edges) {
      const targetNode = nodes.get(target);
      if (!targetNode || targetNode.state === "done" || targetNode.state === "cancelled") continue;
      if (visit(target)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const id of nodes.keys()) {
    if (visit(id)) return true;
  }
  return false;
}

function reachesTarget(from: Id, target: Id, nodes: ReadonlyMap<Id, TaskState>, seen = new Set<Id>()): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const node = nodes.get(from);
  if (!node || node.state === "done" || node.state === "cancelled") return false;
  const edges = [...(node.after ?? []), ...(runtimeWaitHolds(node) ? node.runtimeWait!.after : [])];
  return edges.some((next) => reachesTarget(next, target, nodes, seen));
}

describe("seeded scheduler, dependency DAG, and screen arbitration invariants", () => {
  it("enforces global limits, per-tool caps, slowdown windows, priority order, and greedy non-starvation across 32 seeds", () => {
    const tools = ["claude-code", "codex", "grok"] as const;
    const modelsByTool: Record<(typeof tools)[number], readonly string[]> = {
      "claude-code": ["Claude Opus 4.6", "Claude Sonnet 4.6"],
      codex: ["GPT-5.4", "GPT-5.3 Codex"],
      grok: ["Grok 4.2"],
    };

    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let step = 0; step < 25; step += 1) {
        const now = 1_700_000_000_000 + step * 60_000;
        const toolCaps: Record<Id, number> = {};
        for (const tool of tools) {
          if (rng() < 0.8) toolCaps[tool] = randInt(rng, 0, 5);
        }
        const usage: UsageReport[] = [];
        const reportCount = randInt(rng, 0, 4);
        for (let r = 0; r < reportCount; r += 1) {
          const toolId = pickOne(rng, tools);
          const kind =
            toolId === "claude-code"
              ? pickOne(rng, ["five_hour", "seven_day_opus", "seven_day_sonnet"] as const)
              : "five_hour";
          const model =
            kind === "seven_day_opus" ? "opus" : kind === "seven_day_sonnet" ? "sonnet" : undefined;
          const stale = rng() < 0.2;
          const expired = rng() < 0.2;
          usage.push({
            toolId,
            kind,
            ...(model ? { model } : {}),
            status: "allowed_warning",
            utilization: Number((rng() * 1.05).toFixed(3)),
            at: stale ? now - 45 * 60_000 : now - 60_000,
            ...(stale
              ? {}
              : { resetsAt: expired ? now - 1_000 : now + randInt(rng, 10, 240) * 60_000 }),
          });
        }

        const pool: Pool = {
          limit: randInt(rng, 0, 8),
          paused: rng() < 0.2,
          toolCaps,
          usage,
        };

        const inUseCount = randInt(rng, 0, 9);
        const inUse: SlotUse[] = Array.from({ length: inUseCount }, (_, index) => {
          const toolId = pickOne(rng, tools);
          const model = pickOne(rng, modelsByTool[toolId]);
          return { taskId: `active-${index}`, toolId, model };
        });

        const candidateCount = randInt(rng, 0, 16);
        const candidates: Candidate[] = Array.from({ length: candidateCount }, (_, index) => {
          const toolId = pickOne(rng, tools);
          const model = pickOne(rng, modelsByTool[toolId]);
          return { taskId: `cand-${index}`, toolId, model };
        });

        const starts = pickStarts({ candidates, inUse, pool, now });
        const diag = `seed=${seed} step=${step}`;

        if (pool.paused || inUse.length >= pool.limit) {
          expect(starts, diag).toEqual([]);
        } else {
          expect(inUse.length + starts.length, diag).toBeLessThanOrEqual(pool.limit);
        }

        // Relative priority order of picked candidates is strictly preserved.
        const pickedIndices = starts.map((id) => candidates.findIndex((c) => c.taskId === id));
        for (let i = 1; i < pickedIndices.length; i += 1) {
          expect(pickedIndices[i]!, diag).toBeGreaterThan(pickedIndices[i - 1]!);
        }

        // Reconstruct progressive uses and verify both cap compliance and greedy non-starvation.
        const runningUses: SlotUse[] = [...inUse];
        const pickedSet = new Set(starts);
        for (const candidate of candidates) {
          const cap = pool.toolCaps[candidate.toolId];
          const onToolBefore = runningUses.filter((u) => u.toolId === candidate.toolId).length;
          const slowedCap = toolCapNow(pool, candidate.toolId, now, candidate);
          const blockedByToolCap = cap !== undefined && onToolBefore >= cap;
          const blockedBySlowdown =
            slowedCap !== undefined
            && (pool.usage ?? []).some(
              (report) =>
                currentReport(report, now)
                && usageCovers(report, candidate)
                && pastSlowDown(report)
                && runningUses.filter((u) => usageCovers(report, u)).length >= slowedCap,
            );

          if (pickedSet.has(candidate.taskId)) {
            expect(pool.paused, diag).toBe(false);
            expect(runningUses.length, diag).toBeLessThan(pool.limit);
            expect(blockedByToolCap, diag).toBe(false);
            expect(blockedBySlowdown, diag).toBe(false);
            runningUses.push(candidate);
          } else if (!pool.paused && runningUses.length < pool.limit) {
            expect(blockedByToolCap || blockedBySlowdown, diag).toBe(true);
          }
        }

        // balanced() is an exact permutation of candidates.
        const reordered = balanced(candidates, pool, now);
        expect(reordered.map((c) => c.taskId).sort(), diag).toEqual(
          candidates.map((c) => c.taskId).sort(),
        );

        // extraSlot() on an equivalent State agrees with pool pause & global limit.
        const demoTools: readonly Tool[] = [
          { id: "claude-code", name: "Claude Code", command: ["claude"], status: "ready", models: modelsByTool["claude-code"] },
          { id: "codex", name: "Codex", command: ["codex"], status: "ready", models: modelsByTool.codex },
          { id: "grok", name: "Grok", command: ["grok"], status: "ready", models: modelsByTool.grok },
        ];
        const stateForExtra: State = {
          seq: 1,
          now,
          pool,
          tools: demoTools,
          profiles: DEFAULT_PROFILES,
          roles: BUILT_IN_ROLES,
          products: DEMO_PRODUCTS,
          tasks: inUse.map((use, idx) => {
            const matchingProfile =
              DEFAULT_PROFILES.find((p) => p.toolId === use.toolId) ?? DEFAULT_PROFILES[0]!;
            const task = createTaskState(
              { productId: "demo", title: `Active ${idx}` },
              DEMO_PRODUCTS,
              { id: use.taskId, timelineId: `tl-${idx}`, now, priority: idx },
            );
            task.state = "running";
            task.holdsSlot = true;
            task.agent = {
              roleId: "builder",
              profileId: matchingProfile.id,
              since: now,
              step: 0,
            };
            return displayTask(task);
          }),
          inbox: [],
        };
        expect(slotUses(stateForExtra).length, diag).toBe(inUse.length);
        if (pool.paused || inUse.length >= pool.limit) {
          for (const tool of tools) {
            expect(extraSlot(stateForExtra, tool), diag).toBe(false);
          }
        }
      }
    }
  });

  it("maintains strict DAG acyclicity across static prerequisites, live runtimeWait edges, and task completions across 32 seeds", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed + 1_000);
      const nowBase = 1_700_000_000_000;
      const tasks = new Map<Id, DeepMutable<TaskState>>();
      const ids = Array.from({ length: 10 }, (_, idx) => `task-${idx}`);
      for (const [idx, id] of ids.entries()) {
        const task = createTaskState(
          { productId: "demo", title: `Task ${idx}` },
          DEMO_PRODUCTS,
          { id, timelineId: `tl-${idx}`, now: nowBase, priority: idx },
        );
        if (idx % 2 === 0) {
          task.state = "running";
          task.startedAt = nowBase;
        }
        tasks.set(id, task);
      }

      const find = (id: Id) => tasks.get(id);

      for (let step = 0; step < 45; step += 1) {
        const now = nowBase + step * 1_000;
        const diag = `seed=${seed} step=${step}`;
        const op = rng();
        const subjectId = pickOne(rng, ids);
        const subject = tasks.get(subjectId)!;

        if (op < 0.45) {
          // Mutate static `after` prerequisites.
          const count = randInt(rng, 0, 4);
          const proposed = Array.from({ length: count }, () => pickOne(rng, ids));
          const unique = [...new Set(proposed)];
          const wouldSelfWait = unique.includes(subjectId);
          const wouldCycle =
            !wouldSelfWait && unique.some((targetId) => reachesTarget(targetId, subjectId, tasks));

          if (wouldSelfWait || wouldCycle) {
            expect(() => validateTaskDependencies(subjectId, proposed, find), diag).toThrow();
          } else {
            const validated = validateTaskDependencies(subjectId, proposed, find);
            subject.after = validated;
          }
        } else if (op < 0.8) {
          // Mutate live `runtimeWait`.
          if (subject.startedAt === undefined && subject.state === "queued") {
            subject.state = "running";
            subject.startedAt = now;
          }
          const clear = rng() < 0.25;
          const proposed = clear
            ? []
            : Array.from({ length: randInt(rng, 1, 3) }, () => pickOne(rng, ids));
          const unique = [...new Set(proposed)];
          const invalidState =
            subject.startedAt === undefined
            || subject.state === "done"
            || subject.state === "cancelled"
            || subject.state === "pr-open";
          const selfOrFinished = unique.some((id) => {
            if (id === subjectId) return true;
            const other = tasks.get(id);
            return !other || other.state === "done" || other.state === "cancelled";
          });
          const wouldCycle =
            !invalidState
            && !selfOrFinished
            && unique.some((targetId) => reachesTarget(targetId, subjectId, tasks));

          if (invalidState || selfOrFinished || wouldCycle) {
            expect(
              () => validateRuntimeWait(subject, proposed, "Wait for prerequisite", find),
              diag,
            ).toThrow();
          } else {
            const validated = validateRuntimeWait(subject, proposed, "Wait for prerequisite", find);
            changeRuntimeWait(subject, { ...validated, requestId: `req-${seed}-${step}` }, now);
          }
        } else {
          // Land and complete a task, then sync all runtimeWaits.
          subject.state = "done";
          subject.finishedAt = now;
          subject.repository = {
            productId: "demo",
            delivery: "local",
            landed: { branch: "main", sha: "a".repeat(40) },
          };
          for (const entry of tasks.values()) {
            syncRuntimeWait(entry, find, now);
          }
          expect(runtimeWaitHolds(subject), diag).toBe(false);
        }

        expect(hasActiveCycle(tasks), diag).toBe(false);
      }
    }
  });

  it("enforces single-holder screen arbitration, FIFO allowed order, hour expiry, and runtimeWait yielding across 32 seeds", () => {
    const modes: readonly ScreenMode[] = ["off", "on", "hour"];
    for (const seed of SEEDS) {
      const rng = mulberry32(seed + 2_000);
      for (let step = 0; step < 30; step += 1) {
        const now = 1_700_000_000_000 + step * 100_000;
        const diag = `seed=${seed} step=${step}`;
        const chosenMode = pickOne(rng, modes);
        const until = chosenMode === "hour" ? now + randInt(rng, -30_000, 30_000) : undefined;
        const pool: Pick<Pool, "screen"> = {
          screen: chosenMode === "hour" ? { mode: "hour", until } : { mode: chosenMode },
        };

        if (chosenMode === "hour" && (until ?? 0) <= now) {
          expect(screenMode(pool, now), diag).toBe("off");
        } else {
          expect(screenMode(pool, now), diag).toBe(chosenMode);
        }

        const holderIndex = rng() < 0.35 ? randInt(rng, 0, 7) : -1;
        const tasks: DeepMutable<TaskState>[] = Array.from({ length: 8 }, (_, idx) => {
          const task = createTaskState(
            { productId: "demo", title: `Screen ${idx}` },
            DEMO_PRODUCTS,
            { id: `scr-${idx}`, timelineId: `tl-${idx}`, now, priority: idx },
          );
          task.state = pickOne(rng, ["waiting", "needs-you", "running", "done"] as const);
          if (rng() < 0.4) task.screenAllowed = true;
          const wantsScreen = idx === holderIndex || rng() < 0.6;
          if (wantsScreen && task.state !== "done") {
            const granted = idx === holderIndex && task.state === "running";
            task.screen = {
              reason: `Verify UI ${idx}`,
              at: now - randInt(rng, 1, 500) * 100 + idx,
              roleId: "tester",
              profileId: "opus-high",
              ...(granted ? { granted: true } : {}),
              ...(rng() < 0.35 ? { allowed: true } : {}),
            };
          }
          if (!task.screen?.granted && task.state === "waiting" && rng() < 0.3) {
            task.startedAt = now - 1_000;
            task.runtimeWait = {
              after: ["prereq-1"],
              reason: "Waiting for API",
              changes: [{ at: now - 500, before: [], after: ["prereq-1"], reason: "Waiting for API" }],
            };
          }
          return task;
        });

        const screenState = { tasks, pool };
        const currentHolder = onScreen(tasks);
        const queue = screenQueue(tasks);

        // Held tasks never occupy screenQueue.
        expect(queue.every((t) => !runtimeWaitHolds(t)), diag).toBe(true);
        // screenQueue is strictly non-decreasing by request timestamp.
        for (let i = 1; i < queue.length; i += 1) {
          expect(queue[i]!.screen!.at, diag).toBeGreaterThanOrEqual(queue[i - 1]!.screen!.at);
        }

        const nextId = screenNext(screenState, now);
        if (currentHolder) {
          expect(nextId, diag).toBeUndefined();
          for (const task of tasks) {
            if (task.id === currentHolder.id) {
              expect(screenReady(task, screenState, now), diag).toBe(true);
              expect(screenWait(task, screenState, now), diag).toBeUndefined();
            } else if (
              (task.state === "waiting" || task.state === "needs-you")
              && task.screen
              && !task.screen.granted
              && !runtimeWaitHolds(task)
              && screenAllowed(task, pool, now)
            ) {
              expect(screenWait(task, screenState, now), diag).toBe("turn");
              expect(screenReady(task, screenState, now), diag).toBe(false);
            }
          }
        } else {
          const expectedNext = queue.find((t) => screenAllowed(t, pool, now))?.id;
          expect(nextId, diag).toBe(expectedNext);
          if (expectedNext) {
            const winner = tasks.find((t) => t.id === expectedNext)!;
            expect(screenReady(winner, screenState, now), diag).toBe(true);
            expect(screenWait(winner, screenState, now), diag).toBeUndefined();
          }
        }
      }
    }
  });
});
