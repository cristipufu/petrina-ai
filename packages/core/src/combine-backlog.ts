import type { NewTaskInput } from "./commands.js";
import type { Id, Task } from "./model.js";

/** Validate the whole selection before changing any task. Combining never relaxes a saved choice. */
export function combinedBacklogInput(tasks: readonly Task[], ids: readonly Id[], title: string): NewTaskInput {
  if (ids.length < 2 || ids.length > 20 || new Set(ids).size !== ids.length) throw new Error("Select between 2 and 20 different backlog tasks.");
  const selected = ids.map((id) => tasks.find((task) => task.id === id));
  if (selected.some((task) => !task || task.state !== "backlog" || task.startedAt !== undefined)) throw new Error("Only backlog tasks that have never started can be combined. Refresh the selection.");
  const sources = selected as Task[];
  const cleanTitle = title.trim();
  if (!cleanTitle || cleanTitle.length > 200) throw new Error("Give the combined task a title of up to 200 characters.");
  if (sources.some((task) => task.after?.length) || tasks.some((task) => task.after?.some((id) => ids.includes(id)))) throw new Error("Resolve these tasks’ dependencies before combining them.");
  const choices = (task: Task) => task.selectedProducts ?? (task.workChoice ? [task.workChoice] : task.productId ? [{
    productId: task.productId,
    startFrom: { kind: "default" },
    delivery: task.delivery
  }] : []);
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort((
    [a],
    [b]
  ) => a.localeCompare(b)).map(([key, entry]) => [
    key,
    stable(entry)
  ])) : value;
  const key = (task: Task) => JSON.stringify(stable([...choices(task)].sort((a, b) => a.productId.localeCompare(b.productId))));
  if (sources.some((task) => key(task) !== key(sources[0]!))) throw new Error("Choose tasks with the same products, starting points and delivery choices. Edit those choices first if needed.");
  const description = sources.map((task, index) => `${index + 1}. ${task.title}\nOriginal task: ${task.id}\n${task.description}`).join("\n\n");
  if (description.length > 8000) throw new Error("The combined request is too long. Select fewer tasks.");
  return {
    productId: sources[0]!.productId,
    worksOn: choices(sources[0]!),
    title: cleanTitle,
    description,
    kind: sources.every((task) => task.kind === sources[0]!.kind) ? sources[0]!.kind : "feature",
    approvePlan: sources.some((task) => task.approvePlan),
    approveDelivery: sources.some((task) => task.approveDelivery),
    backlog: true
  };
}
