import { createTaskState, type Product } from "@petrina/core";

/** Private data for the actual local-API conversation projection, without an Engine or database. */
export function conversationFixture() {
  const product: Product = { id: "product", name: "Example", repo: "local/example", tone: "blue", delivery: "local" };
  const taskId = "task-1";
  const task = createTaskState({ productId: product.id, title: "First task", backlog: true }, [product], { id: taskId, timelineId: "created", now: 1, priority: 0 });
  return { task, taskId };
}

/** A recorded start on a review place, as the engine saves it when the participant's opening goes out. */
export const reviewerStart = (profileId: string, reviewerKey: string, at: number, requestedProfileId = profileId) =>
  ({ at, roleId: "code-reviewer", profileId, requestedProfileId, reviewerKey, taskTitle: "First task", mode: "fresh" as const, sections: [] });
