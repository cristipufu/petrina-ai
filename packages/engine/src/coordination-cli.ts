import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EngineClient } from "./engine-client.js";
import { OPERATIONS, operation } from "./operations.js";
import type { Result } from "./coordination.js";
const kebab = (text: string) => text.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const camel = (text: string) => text.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
export const exitCode = (outcome: string) =>
  ["completed", "pending"].includes(outcome)
    ? 0
    : outcome === "timed-out"
      ? 3
      : ["missing", "handled", "unavailable"].includes(outcome)
        ? 4
        : ["conflict", "changed", "continuity-lost", "superseded"].includes(outcome)
          ? 5
          : ["failed", "disconnected"].includes(outcome)
            ? 1
            : 2;
function human(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.map((item) => (typeof item === "object" ? human(item, depth) : `• ${String(item)}`)).join("\n");
  return Object.entries(value)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      const label = key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
      return typeof value === "object"
        ? `${label}:\n${human(value, depth + 1)
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n")}`
        : `${label}: ${String(value)}`;
    })
    .join("\n");
}
export function commandHelp(group?: string, verb?: string): string {
  const selected = verb ? operation(`${group}.${verb}`) : undefined;
  if (selected) {
    const schema = z.toJSONSchema(selected.schema) as {
      properties?: Record<string, { description?: string; type?: string; default?: unknown; enum?: unknown[] }>;
      required?: string[];
    };
    return [
      `petrina ${group} ${verb}`,
      selected.description,
      "",
      ...Object.entries(schema.properties ?? {}).map(
        ([key, value]) =>
          `  --${kebab(key)}${value.type === "boolean" ? "" : " <value>"}${schema.required?.includes(key) ? " (required)" : ""}${value.enum ? ` [${value.enum.join(" | ")}]` : ""}${value.default !== undefined ? ` (default: ${JSON.stringify(value.default)})` : ""}${value.description ? ` — ${value.description}` : ""}`,
      ),
      "  --json  Machine-readable result",
      "Arrays and objects take a JSON value. Boolean flags accept true or false.",
    ].join("\n");
  }
  return [
    "Petrina coordination",
    "Usage: petrina <group> <operation> [options] [--json]",
    "",
    ...OPERATIONS.filter((op) => !group || op.name.startsWith(`${group}.`)).map((op) => `  ${op.name.replace(".", " ")} — ${op.description}`),
    "",
    "Use petrina <group> <operation> --help for named arguments.",
    "petrina mcp starts the stdio MCP connection; it never starts the engine by connecting.",
    "Legacy commands: state, do, serve, open.",
    "Exit codes: 0 completed or accepted; 1 failed/disconnected; 2 invalid; 3 deadline; 4 missing/handled/unavailable; 5 changed/conflicting/superseded/lost continuity.",
  ].join("\n");
}
export async function coordinationCli(argv: string[], client = new EngineClient()): Promise<number> {
  const [group, verb, ...rest] = argv;
  if (!group || group === "help" || group === "--help" || group === "-h") {
    console.log(commandHelp());
    return 0;
  }
  if (!verb || verb === "--help" || verb === "help") {
    console.log(commandHelp(group));
    return 0;
  }
  const spec = operation(`${group}.${verb}`);
  if (!spec) {
    console.error("Unknown operation. Use petrina --help.");
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(commandHelp(group, verb));
    return 0;
  }
  const args: Record<string, unknown> = {};
  const json = rest.includes("--json");
  const schema = z.toJSONSchema(spec.schema) as { properties: Record<string, { type?: string; anyOf?: unknown; oneOf?: unknown }> };
  try {
    for (let index = 0; index < rest.length; index++) {
      const flag = rest[index]!;
      if (flag === "--json") continue;
      if (!flag.startsWith("--")) {
        const key = schema.properties.taskId ? "taskId" : schema.properties.itemId ? "itemId" : schema.properties.productId ? "productId" : undefined;
        if (!key || args[key] !== undefined) throw new Error("Use named options shown in this command's help.");
        args[key] = flag;
        continue;
      }
      const equal = flag.indexOf("="),
        key = camel(flag.slice(2, equal < 0 ? undefined : equal));
      const field = schema.properties[key];
      if (!field) throw new Error(`Unknown option --${kebab(key)}.`);
      const inline = equal < 0 ? undefined : flag.slice(equal + 1);
      if (field.type === "boolean") {
        const next = inline ?? rest[index + 1];
        if (next === "true" || next === "false") {
          args[key] = next === "true";
          if (inline === undefined) index++;
        } else args[key] = true;
      } else {
        const value = inline ?? rest[++index];
        if (value === undefined || value.startsWith("--")) throw new Error(`--${kebab(key)} needs a value.`);
        args[key] =
          field.type === "number" || field.type === "integer"
            ? Number(value)
            : field.type === "array" || field.type === "object" || field.anyOf || field.oneOf || value === "null"
              ? JSON.parse(value)
              : value;
      }
    }
    if (spec.changes && !args.requestId) {
      args.requestId = randomUUID();
      console.error(`Request reference: ${args.requestId}`);
    }
    const result: Result = await client.call(spec.name, args);
    console.log(json ? JSON.stringify(result) : human(result));
    return exitCode(result.outcome);
  } catch (error) {
    const result = { outcome: "invalid", message: error instanceof Error ? error.message : "The arguments could not be read." };
    console.log(json ? JSON.stringify(result) : human(result));
    return 2;
  }
}
