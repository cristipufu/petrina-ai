import { VerifierBallots, type VerifierSelection } from "@petrina/orchestrator";
import { verifierProfiles, type Id, type Stage } from "@petrina/core";
import type { Kernel } from "./kernel.js";

/** Native composition only: the controller receives its existing narrow catalog/selection/recording ports. */
type SelectionHost = Pick<Kernel, "profile" | "choose" | "usableTools" | "taskAdmissionsClosed"> & {
  readonly s: Pick<Kernel["s"], "tools" | "profiles" | "roles">;
};
type VerifierHost = SelectionHost & Pick<Kernel, "named" | "role" | "commitNow" | "commit" | "log">;

const votesRoleId = (k: SelectionHost): Id =>
  k.s.roles.find((role) => !role.removed && role.result === "votes")?.id ?? "verifier";

/** Prefer the tool's high-effort profile for claims; discovery keeps the stage's configured effort. */
function candidates(k: SelectionHost, stage: Stage): Id[] {
  return verifierProfiles({ profiles: k.s.profiles, tools: k.s.tools, usable: k.usableTools(),
    planned: stage.profileIds.map(id => ({ id, toolId: k.profile(id)?.toolId })) });
}

export function createVerifierSelection(k: SelectionHost): VerifierSelection {
  return {
    candidates: stage => candidates(k, stage), admissionsClosed: task => k.taskAdmissionsClosed(task),
    resolve: (task, id) => {
      const choice = k.choose(id, task, votesRoleId(k));
      if (!choice) return undefined;
      return choice.kind === "none"
        ? { kind: choice.capacity ? "capacity" : "unavailable", waiting: choice.waiting }
        : { kind: "selected", profile: { id: choice.profile.id, toolId: choice.profile.toolId } };
    },
  };
}

export function createVerifierBallots(k: VerifierHost): VerifierBallots {
  return new VerifierBallots({
    profile: id => k.profile(id), profileName: id => k.named(id),
    toolName: id => k.s.tools.find(tool => tool.id === id)?.name ?? id,
    roleResult: (id, task) => k.role(id, task)?.result,
  }, createVerifierSelection(k), {
    checkpoint: task => k.commitNow(task),
    changed: task => k.commit(task),
    note: (
    task,
    tone,
    text
  ) => k.log(
    task,
    tone,
    text
  ),
    now: () => Date.now()
  });
}
