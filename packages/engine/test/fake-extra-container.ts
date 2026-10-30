// A private container service: killing its attached client intentionally leaves the workload behind.
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUN_LABEL } from "../src/extra-container.js";
import { privateContainerCall } from "./fixtures/container-inspection.js";

const [root, ...raw] = process.argv.slice(2);
if (!root) throw new Error("A private service folder is required");
const childProgram = raw[0]?.startsWith("--fixture-child=") ? raw.shift()!.slice("--fixture-child=".length) : undefined;
let args = raw;
while (args[0] === "--host" || args[0] === "--config") args = args.slice(2);
const [command] = args;
const value = (flag: string) => args[args.indexOf(flag) + 1]!;
const labels = args.flatMap((word, index) => word === "--label" ? [args[index + 1]!] : []);
let reply: string | undefined;
try { reply = privateContainerCall(root, args); }
catch (error) { if (error instanceof Error && error.message) console.error(error.message); process.exit(1); }
if (reply !== undefined) { if (reply) console.log(reply); }
else if (command === "run") {
  const name = value("--name"), path = join(root, "containers", name);
  const id = labels.find(label => label.startsWith(RUN_LABEL + "="))!.split("=")[1]!;
  const snapshot = value("--mount").match(/src=(.*),dst=/)?.[1];
  if (!snapshot) throw new Error("The private snapshot mount is required");
  const record = { args, labels, pid: process.pid, childPid: undefined as number | undefined, id, name, snapshot };
  const mode = args.at(-1);
  // Unpublished service metadata is not a container. Keep it in the client's owned
  // snapshot so interruption cleanup removes it, even after SIGKILL bypasses finally.
  // Both folders belong to this fixture on the same filesystem; rename publishes atomically.
  const temporary = join(record.snapshot, ".git", `fake-container-${name}`);
  writeFileSync(temporary, JSON.stringify(record));
  if (mode === "hold-before-create") {
    writeFileSync(join(root, "creating", id), "ready to publish");
    await new Promise<void>(resolve => process.once("SIGUSR1", resolve));
  }
  renameSync(temporary, path);
  if (mode === "hold-child") {
    if (!childProgram) throw new Error("The hold-child control requires its independently owned private child program");
    const child = Bun.spawn([process.execPath, childProgram], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const reader = child.stdout.getReader();
    await reader.read(); reader.releaseLock();
    record.childPid = child.pid;
  }
  let release!: () => void;
  const released = mode?.startsWith("hold") ? new Promise<void>(resolve => { release = resolve; process.once("SIGUSR1", release); }) : Promise.resolve();
  if (mode !== "hold-silent") console.log("Original complete diagnostic for " + id);
  writeFileSync(join(root, "started", id) + ".tmp", JSON.stringify(record));
  renameSync(join(root, "started", id) + ".tmp", join(root, "started", id));
  await released;
  rmSync(path, { force: true });
  console.log("Original ending for " + id);
  if (mode === "fail") process.exitCode = 1;
} else throw new Error("Unsupported fake operation: " + args.join(" "));
