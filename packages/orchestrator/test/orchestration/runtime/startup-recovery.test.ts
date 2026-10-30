import { describe, expect, it } from "vitest";
import type { DeepMutable, InboxItem } from "@petrina/core";
import { recoverStartupWork } from "../../../src/index.js";
import { repositoryTask } from "../../fixtures/tasks.js";

describe("recoverStartupWork", () => {
  it("drops open permission requests, retains conversation questions, and returns interrupted tasks to waiting", () => {
    const running = repositoryTask(false);
    running.id = "running-task";
    running.state = "running";
    running.holdsSlot = true;
    running.workValidating = true;
    running.agent = { roleId: "builder", profileId: "builder", since: 100, step: 0 };
    running.helpers = [{ roleId: "code-reviewer", profileId: "reviewer", since: 100, step: 0 }];

    const asking = repositoryTask(false);
    asking.id = "asking-task";
    asking.state = "needs-you";
    asking.holdsSlot = true;
    asking.repository!.conversation = {
      step: "build",
      roleId: "builder",
      profileId: "builder",
      sessionId: "session-1",
      toolId: "codex",
      model: "gpt-5",
      startedAt: 100,
      asked: { itemId: "ask-1", question: "Which path?" },
    };

    const driving = repositoryTask(false);
    driving.id = "driving-task";
    driving.state = "running";
    driving.driving = {
      since: 100,
      roleId: "builder",
      profileId: "builder",
      toolId: "codex",
      head: "abc1234",
    };

    const inbox: DeepMutable<InboxItem>[] = [
      {
        id: "perm-1",
        taskId: running.id,
        kind: "permission",
        title: "Run deploy",
        blocking: true,
        at: 110,
        roleId: "builder",
        profileId: "builder",
      },
      {
        id: "ask-1",
        taskId: asking.id,
        kind: "question",
        title: "Which path?",
        blocking: true,
        at: 120,
      },
    ];

    const dropped: string[] = [];
    const kept = recoverStartupWork([running, asking, driving], inbox, {
      now: () => 500,
      onDroppedPermission: (_task, item) => dropped.push(item.id),
    });

    expect(dropped).toEqual(["perm-1"]);
    expect(kept.map((item) => item.id)).toEqual(["ask-1"]);

    expect(running.state).toBe("waiting");
    expect(running.statusLine).toBe("Waiting for a free slot");
    expect(running.holdsSlot).toBe(false);
    expect(running.agent).toBeUndefined();
    expect(running.helpers).toBeUndefined();
    expect(running.workValidating).toBe(false);
    expect(running.workError).toContain("Validation was interrupted");

    expect(asking.state).toBe("needs-you");
    expect(asking.statusLine).toBe("Waiting for your answer");
    expect(asking.holdsSlot).toBe(false);
    expect(asking.agent).toBeUndefined();

    expect(driving.state).toBe("needs-you");
    expect(driving.holdsSlot).toBe(true);
  });
});
