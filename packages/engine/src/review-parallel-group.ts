import { existsSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import {
  completeAll,
  inBallot,
  openStep,
  seatAnswered,
  type ActiveAgent,
  type AgentProfile,
  type Id,
  type ReadinessRecheck,
} from "@petrina/core";
import {
  executionFor,
  ParallelAdmissionGroup,
  type PendingVerification,
  type VerifierBallots,
} from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import type { Context } from "./context.js";
import { SourceRefreshRequired, type Kernel, type RuntimeTask } from "./kernel.js";
import { formatFindings } from "./prompts.js";
import type { ReviewInput } from "./review-context.js";
import { VerifyResult } from "./roles.js";
import type { Turns } from "./turn.js";

/** What admission decided for a parallel seat: the words on its start, why a saved conversation was not kept, and its readiness recheck. */
export type SeatSelection = { selectionReason?: string; freshReason?: string; readiness?: ReadinessRecheck };

export interface ParallelReviewMember {
  key: string;
  reviewKey: string;
  roleId: Id;
  profileId: Id;
  reviewerKey?: string;
  work: (
    copy: string,
    room: (toolId: Id, profile: AgentProfile) => boolean,
    seat: Id,
    used: (profileId: Id) => void,
    agent: ActiveAgent,
    continuing: boolean,
    signal: AbortSignal,
    selection?: SeatSelection,
  ) => Promise<void>;
}

/**
 * Fresh agents check their place's findings, all at once, each blind to its peers' answers. Every answer is saved
 * as it arrives with its place, so a limit or restart only asks for what that place still owes.
 */
export async function runVerificationVote(
  deps: {
    k: Kernel;
    turns: Turns;
    context: Context;
    ballots: VerifierBallots;
    readInput: (task: RuntimeTask, signal: AbortSignal) => Promise<ReviewInput>;
    together: (
      task: RuntimeTask,
      members: readonly ParallelReviewMember[],
      signal: AbortSignal,
      status: (running: number, waiting: number) => string,
    ) => Promise<void>;
  },
  task: RuntimeTask,
  pending: PendingVerification,
  signal: AbortSignal,
): Promise<void> {
  const { k, turns, context, ballots } = deps;
  const scope = executionFor(task);
  const input = task.hunt?.input ? await deps.readInput(task, signal) : undefined;
  // Every voter sees the same original claims and evidence, never a peer's ballot.
  const claims = structuredClone(pending.findings).map(
    ({ votes: _votes, verification: _verification, unresolved: _unresolved, ...finding }) => finding,
  );
  // The step waits for every place of its phase, finished or not, whoever stands in on each tool.
  const seats = (pending.phase ?? pending.seats).map((seat) => `verifier:${seat.key}`);
  // The live status counts only the findings these places were given.
  const findings = new Set(
    pending.seats.flatMap((seat) => seat.findingIds).filter((id) => claims.some((finding) => finding.id === id)),
  ).size;
  const votesRoleId = k.s.roles.find((role) => !role.removed && role.result === "votes")?.id ?? "verifier";
  await deps.together(
    task,
    pending.seats.map((planned, index) => {
      const profileId = pending.voters[index]!;
      const plannedId = planned.profileId;
      const assigned = new Set(planned.findingIds);
      // The member is named after its place, never its tool: a replacement saves its conversation and retry count
      // there, a later start of this place finds them under the same name, and a reused tool never shares them.
      const key = `vote-${planned.key}`;
      const reviewKey = `verifier:${planned.key}`;
      return {
        key,
        reviewKey,
        roleId: votesRoleId,
        profileId,
        work: async (copy, room, seat, used, agent, continuing, turnSignal, selection) => {
          let by = seat;
          const place = () => task.hunt?.panel?.seats.find((entry) => entry.key === planned.key) ?? planned;
          const answered = (id: Id) => {
            const finding = task.findings.find((entry) => entry.id === id);
            const panel = task.hunt?.panel;
            if (!finding) return true;
            return panel
              ? seatAnswered(panel, place(), finding, task.hunt!)
              : (finding.votes ?? []).some(
                  (vote) => vote.toolId === k.profile(by)!.toolId && inBallot(vote, task.hunt!),
                );
          };
          const missing = () => claims.filter((finding) => assigned.has(finding.id) && !answered(finding.id));
          const given = async () => [
            ...(await context.sectionsFor(
              scope,
              votesRoleId,
              key,
              turns.repositoryCopies.get(copy),
              undefined,
              input,
            )),
            {
              title: "Important findings to check (a verdict on every one, by id)",
              body: formatFindings(missing(), { complete: true }),
            },
          ];
          const check = (value: z.infer<typeof VerifyResult>) => {
            ballots.recordAnswers(
              task,
              { profileId: by, plannedProfileId: plannedId, place: place(), findingIds: [...assigned] },
              value.verdicts,
            );
            const left = missing();
            return left.length
              ? `give a verdict on every finding by id, and these have none:\n${formatFindings(left, { complete: true })}`
              : undefined;
          };
          const heard = (id: Id) => {
            by = id;
            used(id);
          };
          const why = [place().replaced?.reason ?? place().reason, selection?.selectionReason]
            .filter(Boolean)
            .join(" ");
          if (continuing) {
            await turns.turn(scope, votesRoleId, plannedId, given, VerifyResult, turnSignal, {
              copy,
              member: key,
              reviewKey,
              check,
              used: heard,
              room,
              seats,
              place: planned.key,
            });
          } else {
            await turns.parallel(scope, votesRoleId, plannedId, copy, given, VerifyResult, turnSignal, {
              key: reviewKey,
              room,
              seat,
              ...selection,
              ...(why ? { selectionReason: why } : {}),
              used: heard,
              member: key,
              check,
              seats,
              place: planned.key,
              agent,
              refresh: false,
            });
          }
          task.hunt = { ...task.hunt!, voted: { ...task.hunt?.voted, [by]: true } };
          const own = openStep(task)?.agentResults?.findLast(
            (entry) =>
              (k.role(entry.roleId, task)?.result === "votes" || entry.roleId === "verifier") && entry.profileId === by,
          );
          if (own) own.findings = structuredClone(task.findings.filter((finding) => assigned.has(finding.id)));
          k.finishReviewWork(task, reviewKey);
          k.commit();
        },
      };
    }),
    signal,
    (running, waiting) =>
      `${running} fresh agent${running === 1 ? "" : "s"} ${pending.third ? "giving a third answer on" : "voting on"} ${findings} important finding${findings === 1 ? "" : "s"}${waiting ? `, ${waiting} waiting for a slot` : ""}`,
  );
}

/**
 * Several agents on one step at once, each in a working copy of its own made from the task's current
 * commit, so a test one runs or a checkout one makes never disturbs another, and the task's own copy is
 * never touched.
 */
export async function runParallelReviewGroup(
  k: Kernel,
  turns: Turns,
  rememberReviewer: (task: RuntimeTask, key: string, profileId: Id) => void,
  task: RuntimeTask,
  members: readonly ParallelReviewMember[],
  parentSignal: AbortSignal,
  status: (running: number, waiting: number) => string,
): Promise<void> {
  const scope = executionFor(task);
  const root = k.repositoryOf(scope)!.path!;
  const copyFolder = (productId: Id) => join(k.dataDir, "worktrees", productId, `${task.id}.copies`);
  const folder = copyFolder(scope.work.productId);
  // Pin all repositories before any reviewer starts. Every peer receives its own complete map.
  const versions = task.repositories
    ? await Promise.all(
        task.repositories.map(async (work) => {
          const restoreSha = await git.head(work.worktree!);
          return {
            productId: work.productId,
            root: work.source!.product.path!,
            path: work.worktree!,
            restoreSha,
            sha: task.hunt?.input?.heads[work.productId] ?? restoreSha,
          };
        }),
      )
    : [];
  const restoreSha =
    versions.find((work) => work.productId === scope.work.productId)?.restoreSha ?? (await git.head(scope.work.worktree!));
  const sha = task.hunt?.input?.heads[scope.work.productId] ?? restoreSha;
  const copyOwners = versions.length
    ? versions.map((work) => ({ root: work.root, folder: copyFolder(work.productId) }))
    : [{ root, folder }];
  // Only saved screen conversations keep their copies; interrupted background peers start fresh.
  const keptCopies = () =>
    Object.values(task.hunt?.screenTurns ?? {}).flatMap((entry) => [
      entry.copy,
      ...Object.values(entry.copies ?? {}),
    ]);
  await completeAll(copyOwners.map((owner) => git.removeCopies(owner.root, owner.folder, keptCopies())));
  // Each member's own copy in each product, fixed for the group once chosen, so a member coming back reopens it.
  const chosen = new Map<string, string>();
  const memberCopy = (productId: Id, member: string) => {
    const key = JSON.stringify([productId, member]);
    const known = chosen.get(key);
    if (known !== undefined) return known;
    // Compared without case too: a disk that ignores case treats two such folders as one.
    const held = new Set([...chosen.values(), ...keptCopies()].map((path) => path.toLowerCase()));
    const base = join(copyFolder(productId), git.copyFolderName(member));
    let path = base;
    for (let next = 1; held.has(path.toLowerCase()) || existsSync(path); next += 1) path = `${base}.${next}`;
    chosen.set(key, path);
    return path;
  };
  // One fresh pull-request read is shared by reviewers; a usage replacement reads again on its attempt.
  await turns.refresh(scope);
  // An unopened group must return through ordinary source updates and snapshot preparation.
  if (k.taskSourceRefreshDue(task)) throw new SourceRefreshRequired();
  const group = new ParallelAdmissionGroup(
    {
      state: () => k.s,
      activeState: () => k.activeState(),
      now: () => Date.now(),
      draining: () => k.draining,
      admissionsClosed: (current) => k.taskAdmissionsClosed(current),
      admissionWait: (current) => k.taskAdmissionWait(current),
      sourceRefreshDue: (current) => k.taskSourceRefreshDue(current),
      selectScreen: (current) => k.selectScreen(current),
      syncScreen: () => k.syncScreen(),
      showReviewWork: (current) => k.showReviewWork(current),
      finishStep: (current) => k.finishStep(current),
      waitForUsage: (current, words) => k.waitForUsage(current, words),
      rememberReviewer,
      changed: () => k.commit(),
      checkpoint: () => k.commitNow(),
      schedule: () => k.schedule(),
    },
    k.agentAdmission,
  );
  await group.run({
    scope,
    members,
    signal: parentSignal,
    status,
    workspaces: {
      reference: (member) => memberCopy(scope.work.productId, member),
      prepare: async (member, copy, continuing, reuse) => {
        const kept = continuing ? task.hunt?.screenTurns?.[member.key]?.copies : undefined;
        const copies: Record<string, string> = { [scope.work.productId]: copy };
        await completeAll([
          reuse ? Promise.resolve() : git.addCopy(root, copy, sha),
          ...versions
            .filter((work) => work.productId !== scope.work.productId)
            .map(async (work) => {
              const peer = kept?.[work.productId] ?? memberCopy(work.productId, member.key);
              if (!reuse) await git.addCopy(work.root, peer, work.sha);
              copies[work.productId] = peer;
            }),
        ]);
        return {
          activate: () => {
            if (versions.length) turns.repositoryCopies.set(copy, copies);
            if (!reuse) turns.copyHeads.set(copy, sha);
          },
          finish: () => {
            const saved = task.hunt?.screenTurns?.[member.key];
            if (saved && versions.length) {
              saved.copies = copies;
              saved.conversation.repositoryCopies = copies;
              k.commitNow();
            }
            turns.repositoryCopies.delete(copy);
            turns.copyHeads.delete(copy);
          },
        };
      },
      stopHelpers: () => k.stopHelpers(task.id),
      closeTaskRun: () => {
        const run = k.runs.get(task.id);
        if (run) void k.stopAgent(task.id, run).catch(() => undefined);
      },
      releasedStops: () => turns.releasedStops(task.id),
      finish: async (readOnly) => {
        await completeAll([
          ...copyOwners.map(async (owner) => {
            try {
              await git.removeCopies(owner.root, owner.folder, keptCopies());
            } catch (error) {
              k.log(
                task,
                "warn",
                `Could not remove a review copy: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }),
          ...versions
            .filter((work) => !readOnly || work.path !== scope.work.worktree)
            .map(async (work) => {
              const state = await git.worktreeStatus(work.path);
              if (state.head !== work.restoreSha) await git.resetTo(work.path, work.restoreSha);
              if (!state.clean) await git.discardChanges(work.path);
            }),
          ...(scope.work.worktree && readOnly
            ? [
                (async () => {
                  const state = await git.worktreeStatus(scope.work.worktree!);
                  if (state.head !== restoreSha) {
                    await git.resetTo(scope.work.worktree!, restoreSha);
                    k.log(
                      task,
                      "warn",
                      `Undid commits from ${k.role(members[0]!.roleId)?.name ?? "a reviewer"}, which is read-only`,
                    );
                  }
                  await k.undoReadOnly(scope, members[0]!.roleId, scope.work.worktree!, state.clean);
                })(),
              ]
            : []),
        ]);
      },
    },
  });
}
