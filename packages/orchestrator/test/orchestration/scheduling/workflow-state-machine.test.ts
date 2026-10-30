import {
  columnOf,
  onScreen,
  runtimeWaitHolds,
  slotUses,
  type Id,
  type ScreenMode,
} from "@petrina/core";
import { describe, expect, it } from "vitest";
import { scopesFor, taskView } from "../../../src/repository-context.js";
import { ScreenArbitration } from "../../../src/screen.js";
import type { RuntimeTask } from "../../../src/model.js";
import { admissionFixture } from "../../fixtures/agent-workflow.js";
import { deliveryAdmissionFixture } from "../../fixtures/delivery-admission.js";
import { ReleaseEvents } from "../../fixtures/release-events.js";
import { ScriptedAgents, scriptedResult } from "../../fixtures/scripted-agents.js";
import { findingIds } from "../../fixtures/scripted-findings.js";

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

async function flushMicrotasks(rounds = 16): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function createHoldableSlotAgents() {
  const releases = new ReleaseEvents();
  const heldSessions = new Set<string>();
  const agents = new ScriptedAgents(async (prompt, signal) => {
    if (prompt.turn === 1) {
      heldSessions.add(prompt.sessionId);
      try {
        await releases.wait(prompt.sessionId, signal);
      } finally {
        heldSessions.delete(prompt.sessionId);
      }
    }
    switch (prompt.result) {
      case "plan":
        return scriptedResult({
          rationale: "Fuzz same-tool handoffs, design convergence, build, and parallel review admission.",
          stages: [
            { kind: "do", title: "Research", roleId: "researcher", profileIds: ["opus-high"] },
            {
              kind: "converge",
              title: "Design",
              roleId: "architect",
              profileIds: ["opus-xhigh"],
              reviewerRoleId: "design-reviewer",
              reviewerProfileIds: ["sol-xhigh"],
              maxRounds: 2,
            },
            { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
            {
              kind: "review-chain",
              title: "Review",
              roleId: "code-reviewer",
              profileIds: ["opus-high", "opus-xhigh", "sol-high"],
              maxRounds: 2,
            },
          ],
        });
      case "notes":
        return scriptedResult({ summary: "Checked audience.", notes: ["People see a greeting."] });
      case "brief": {
        if (prompt.turn === 1) {
          return scriptedResult({
            needsInput: { question: "Should the greeting be formal?", options: ["Formal", "Casual"] },
          });
        }
        return scriptedResult({
          summary: "A greeting file.",
          forUsers: ["People see a greeting"],
          areas: ["Greeting"],
          acceptance: ["A greeting file exists"],
          risks: [],
          answers: findingIds(prompt.text, "Objections so far").map((id) => ({
            id,
            status: "accepted",
            byCall: false,
            answer: "Visible to everyone.",
          })),
        });
      }
      case "objections":
        return scriptedResult({
          objections: prompt.text.includes("Objections so far")
            ? []
            : [{ text: "Explain who sees the greeting.", blocking: true }],
        });
      case "build":
        return scriptedResult({
          summary: "Added a greeting.",
          description: "People see a greeting.",
          changes: ["People see a greeting"],
          tests: "Petrina runs the product checks.",
        });
      case "findings":
        return scriptedResult({ verdict: "pass", findings: [], confirms: [], disputes: [] });
      default:
        throw new Error(`Unexpected participant result in state-machine fuzzer: ${prompt.result}`);
    }
  });
  return {
    agents,
    heldSessions,
    release: (sessionId: string) => releases.release(sessionId),
  };
}

const SEEDS = Array.from({ length: 16 }, (_, index) => index + 1);

describe("seeded multi-controller workflow, screen, and delivery-admission state-machine invariants", () => {
  it("preserves slot caps, pause gates, question handoffs, and leak-free quiescence across 16 randomized workflow traces", async () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      const trace: string[] = [];
      const scripted = createHoldableSlotAgents();
      const f = admissionFixture(3, 2, 5, scripted.agents);

      // Move all tasks to backlog initially so the fuzzer controls queueing order.
      for (const id of f.ids) {
        const t = f.task(id)!;
        t.state = "backlog";
        t.column = "backlog";
      }

      // Permitted temporary over-occupancy when pool.limit or toolCaps is dynamically lowered below already-running turns.
      let allowedTotalCeiling = f.state.pool.limit;
      const allowedToolCeiling: Record<Id, number> = {
        "claude-code": f.state.pool.toolCaps["claude-code"] ?? 99,
        codex: f.state.pool.toolCaps.codex ?? 99,
      };
      let maxAllowedWhilePaused = 0;

      const checkWorkflowInvariants = (where: string) => {
        const snap = f.snapshot();
        const uses = slotUses(snap);
        const diag = `seed=${seed} where=${where} trace=${trace.slice(-6).join(" -> ")}`;

        allowedTotalCeiling = Math.max(f.state.pool.limit, Math.min(allowedTotalCeiling, uses.length));
        expect(uses.length, diag).toBeLessThanOrEqual(allowedTotalCeiling);

        for (const toolId of ["claude-code", "codex"] as const) {
          const cap = f.state.pool.toolCaps[toolId];
          if (cap !== undefined) {
            const onTool = uses.filter((u) => u.toolId === toolId).length;
            allowedToolCeiling[toolId] = Math.max(
              cap,
              Math.min(allowedToolCeiling[toolId] ?? onTool, onTool),
            );
            expect(onTool, diag).toBeLessThanOrEqual(allowedToolCeiling[toolId]!);
          }
        }

        if (f.state.pool.paused) {
          maxAllowedWhilePaused = Math.min(maxAllowedWhilePaused, uses.length);
          expect(uses.length, diag).toBeLessThanOrEqual(maxAllowedWhilePaused);
        }

        expect(f.driverErrors, diag).toEqual([]);
        expect(f.failures, diag).toEqual([]);
      };

      const unsubscribe = f.subscribe(() => checkWorkflowInvariants("listener"));

      try {
        for (let step = 0; step < 45; step += 1) {
          const actionRoll = rng();

          if (actionRoll < 0.22) {
            const backlog = f.state.tasks.filter((t) => t.state === "backlog");
            if (backlog.length) {
              const chosen = pickOne(rng, backlog);
              chosen.state = "queued";
              chosen.column = "queue";
              trace.push(`queue(${chosen.id})`);
              f.workflow.schedule();
            }
          } else if (actionRoll < 0.52) {
            const held = [...scripted.heldSessions];
            if (held.length) {
              const sid = pickOne(rng, held);
              trace.push(`release(${sid.slice(0, 6)})`);
              scripted.release(sid);
            }
          } else if (actionRoll < 0.66) {
            const openQuestions = f.state.inbox.filter((item) => item.kind === "question");
            if (openQuestions.length) {
              const q = pickOne(rng, openQuestions);
              trace.push(`answer(${q.taskId})`);
              f.answer(q.id, q.options?.[0] ?? "Formal");
              f.workflow.schedule();
            }
          } else if (actionRoll < 0.78) {
            const nextPaused = !f.state.pool.paused;
            if (nextPaused) {
              maxAllowedWhilePaused = slotUses(f.snapshot()).length;
            }
            f.state.pool.paused = nextPaused;
            trace.push(`paused(${nextPaused})`);
            f.workflow.schedule();
          } else if (actionRoll < 0.9) {
            const currentUses = slotUses(f.snapshot());
            const newLimit = randInt(rng, 1, 4);
            const newClaude = randInt(rng, 1, 3);
            const newCodex = randInt(rng, 1, 3);
            allowedTotalCeiling = Math.max(newLimit, currentUses.length);
            allowedToolCeiling["claude-code"] = Math.max(
              newClaude,
              currentUses.filter((u) => u.toolId === "claude-code").length,
            );
            allowedToolCeiling.codex = Math.max(
              newCodex,
              currentUses.filter((u) => u.toolId === "codex").length,
            );
            f.state.pool.limit = newLimit;
            f.state.pool.toolCaps = { "claude-code": newClaude, codex: newCodex };
            trace.push(`caps(${newLimit},${newClaude},${newCodex})`);
            f.workflow.schedule();
          } else {
            const inject = rng() < 0.6;
            if (inject) {
              const now = f.clock.now();
              f.state.pool.usage = [
                {
                  toolId: pickOne(rng, ["claude-code", "codex"] as const),
                  kind: "five_hour",
                  status: "allowed_warning",
                  utilization: 0.88,
                  at: now,
                  resetsAt: now + 20_000,
                },
              ];
              trace.push("slowdown(on)");
            } else {
              f.clock.advance(25_000);
              trace.push("clock(+25s)");
            }
            f.workflow.schedule();
          }

          await flushMicrotasks();
          checkWorkflowInvariants(`step-${step}`);
        }

        // Drain all started tasks deterministically to their delivery checkpoint and verify zero leaks.
        f.state.pool.paused = false;
        f.state.pool.limit = 5;
        f.state.pool.toolCaps = { "claude-code": 4, codex: 4 };
        f.state.pool.usage = [];
        allowedTotalCeiling = 5;
        allowedToolCeiling["claude-code"] = 4;
        allowedToolCeiling.codex = 4;
        f.workflow.schedule();

        for (let guard = 0; guard < 120; guard += 1) {
          await flushMicrotasks();
          const questions = f.state.inbox.filter((item) => item.kind === "question");
          for (const q of questions) {
            f.answer(q.id, q.options?.[0] ?? "Formal");
          }
          for (const sid of [...scripted.heldSessions]) {
            scripted.release(sid);
          }
          f.clock.advance(1_000);
          f.workflow.schedule();
          await flushMicrotasks();

          const unsettled = f.state.tasks.some(
            (t) =>
              t.state !== "backlog"
              && !(t.state === "needs-you" && t.statusLine === "Ready for your delivery check"),
          );
          if (!unsettled && scripted.heldSessions.size === 0 && f.ownership.drivers.size === 0) {
            break;
          }
        }

        const finalDiag = `seed=${seed} final quiescence`;
        expect(scripted.heldSessions.size, finalDiag).toBe(0);
        expect(f.ownership.drivers.size, finalDiag).toBe(0);
        expect(f.ownership.groups.size, finalDiag).toBe(0);
        expect(slotUses(f.snapshot()).length, finalDiag).toBe(0);
        for (const t of f.state.tasks) {
          if (t.state !== "backlog") {
            expect(t.state, finalDiag).toBe("needs-you");
            expect(t.statusLine, finalDiag).toBe("Ready for your delivery check");
          }
        }
      } finally {
        unsubscribe();
        await f.close();
      }
    }
  });

  it("enforces exclusive ScreenArbitration grants and non-overlapping multi-product DeliveryAdmission turns across 16 seeds", async () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed + 5_000);

      // 1. DeliveryAdmission multi-destination state machine.
      const d = deliveryAdmissionFixture();
      const specs: readonly { id: string; products: string[] }[] = [
        { id: "d-0", products: ["a"] },
        { id: "d-1", products: ["b"] },
        { id: "d-2", products: ["a", "b"] },
        { id: "d-3", products: ["b", "c"] },
        { id: "d-4", products: ["c"] },
        { id: "d-5", products: ["a", "c"] },
      ];
      const deliveryTasks = specs.map((s) => d.add(s.id, s.products));

      // 2. ScreenArbitration state machine.
      const baseFixture = admissionFixture(3, 2, 6);
      let inboxSeq = 0;
      const ownedSessions = new Set<Id>();
      const screen = new ScreenArbitration(
        {
          state: () => baseFixture.state,
          task: (id) => baseFixture.state.tasks.find((t) => t.id === id),
          stopped: () => false,
          inboxId: () => `scr-inbox-${++inboxSeq}`,
          column: (t) => columnOf(taskView(t), baseFixture.state.roles),
          sessionOwned: (t) => ownedSessions.has(t.id),
          waitLine: () => "Waiting for prerequisite task",
          record: () => {},
          checkpoint: () => {},
          schedule: () => screen.syncScreen(),
        },
        {
          now: baseFixture.clock.now,
          after: (ms, fn) => baseFixture.clock.after(ms, () => {
            fn();
            return undefined;
          }),
        },
      );

      const screenTasks: RuntimeTask[] = baseFixture.state.tasks.map((t) => {
        t.state = "running";
        t.startedAt = baseFixture.clock.now();
        return t;
      });

      for (let step = 0; step < 55; step += 1) {
        const diag = `seed=${seed} step=${step}`;

        // Mutate DeliveryAdmission.
        const dt = pickOne(rng, deliveryTasks);
        const dOp = rng();
        if (dOp < 0.35) {
          dt.state = "running";
          d.drivers.add(dt.id);
          const waitReason = d.admission.waitingForTurn(dt);
          if (!waitReason) {
            for (const scope of scopesFor(dt)) {
              const res = d.admission.beforePublishing(scope);
              if (res.kind === "ready") {
                scope.work.shipping = {
                  moves: 0,
                  failures: 0,
                  prepared: { tested: "a".repeat(40), summary: "Ready" },
                  remoteValidation: { ref: "refs/heads/petrina/validation/t", sha: "a".repeat(40), pushed: true },
                };
              }
            }
          }
        } else if (dOp < 0.55) {
          d.admission.yieldForDecision(dt);
          d.drivers.delete(dt.id);
          dt.state = "needs-you";
          for (const { work } of scopesFor(dt)) {
            if (!work.shipping?.pushed && !work.shipping?.step) {
              expect(work.shipping?.prepared, diag).toBeUndefined();
              expect(work.shipping?.remoteValidation, diag).toBeUndefined();
            }
          }
        } else if (dOp < 0.75) {
          d.admission.releaseDeliveryTurn(dt.id);
          d.drivers.delete(dt.id);
          dt.state = "waiting";
        } else if (dOp < 0.9) {
          d.state.paused = rng() < 0.3;
          d.admission.syncDeliveryTurns();
        } else {
          d.admission.finishDeliveryTurn(dt.id);
          d.drivers.delete(dt.id);
        }

        // Assert DeliveryAdmission mutual exclusion per destination product#branch!
        const entries = d.admission.entries();
        expect(new Set(entries.map((entry) => entry.taskId)).size, diag).toBe(entries.length);
        const admittedByDestination = new Map<string, Id>();
        for (const candidate of deliveryTasks) {
          if (candidate.state !== "running" || !d.drivers.has(candidate.id)) continue;
          for (const scope of scopesFor(candidate)) {
            const decision = d.admission.beforePublishing(scope, true);
            if (decision.kind === "ready") {
              const destKey = `${scope.work.productId}#main`;
              const prior = admittedByDestination.get(destKey);
              expect(prior === undefined || prior === candidate.id, `${diag} dest=${destKey}`).toBe(true);
              admittedByDestination.set(destKey, candidate.id);
            }
          }
        }

        // Mutate ScreenArbitration.
        const st = pickOne(rng, screenTasks);
        const sOp = rng();
        if (sOp < 0.28) {
          st.state = "running";
          const granted = screen.askScreen(st, "tester", "opus-high", `Verify ${st.id}`);
          if (granted) ownedSessions.add(st.id);
          else ownedSessions.delete(st.id);
        } else if (sOp < 0.45) {
          screen.allowScreen(st.id);
        } else if (sOp < 0.58) {
          screen.setTaskScreen(st.id, rng() < 0.6);
        } else if (sOp < 0.72) {
          const mode = pickOne(rng, ["off", "on", "hour"] as readonly ScreenMode[]);
          screen.setScreenUse(mode, 10_000);
        } else if (sOp < 0.86) {
          ownedSessions.delete(st.id);
          screen.releaseScreen(st);
        } else {
          if (rng() < 0.5) {
            ownedSessions.delete(st.id);
            st.state = "waiting";
            st.runtimeWait = {
              after: ["other-task"],
              reason: "Prerequisite wait",
              changes: [{ at: baseFixture.clock.now(), before: [], after: ["other-task"], reason: "Prerequisite wait" }],
            };
          } else if (st.runtimeWait) {
            st.runtimeWait.releasedAt = baseFixture.clock.now();
          }
          baseFixture.clock.advance(randInt(rng, 100, 12_000));
          screen.syncScreen();
        }

        // Assert ScreenArbitration invariants!
        const grantedTasks = screenTasks.filter((t) => t.screen?.granted);
        expect(grantedTasks.length, diag).toBeLessThanOrEqual(1);
        if (grantedTasks.length === 1) {
          expect(onScreen(screenTasks)?.id, diag).toBe(grantedTasks[0]!.id);
        }
        for (const t of screenTasks) {
          if (runtimeWaitHolds(t) && !ownedSessions.has(t.id) && !t.driving) {
            expect(t.screen?.granted ?? false, diag).toBe(false);
          }
          const inboxItems = baseFixture.state.inbox.filter(
            (i) => i.taskId === t.id && i.kind === "screen",
          );
          expect(inboxItems.length, diag).toBeLessThanOrEqual(1);
        }
      }

      screen.stop();
      await baseFixture.close();
    }
  });
});
