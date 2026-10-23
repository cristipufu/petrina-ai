// A private container service: killing its attached client intentionally leaves the workload behind.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUN_LABEL } from "../src/extra-container.js";

const [root, ...raw] = process.argv.slice(2);
if (!root) throw new Error("A private service folder is required");
for (const directory of ["containers", "started", "release"]) mkdirSync(join(root, directory), { recursive: true });
let args = raw;
while (args[0] === "--host" || args[0] === "--config") args = args.slice(2);
const [command] = args;
const value = (flag: string) => args[args.indexOf(flag) + 1]!;
const labels = args.flatMap((word, index) => word === "--label" ? [args[index + 1]!] : []);
appendFileSync(join(root, "calls"), JSON.stringify(args) + "\n");
if (existsSync(join(root, "offline"))) { console.error("Private service unavailable"); process.exit(1); }
if (command === "context") console.log(JSON.stringify([{ Endpoints: { docker: { Host: existsSync(join(root, "remote")) ? "ssh://elsewhere" : "unix:///private-fake-service" } } }]));
else if (command === "info") console.log(JSON.stringify({ OSType: "linux", Name: "Private service", ServerVersion: "29.9" }));
else if (command === "image") {
  if (existsSync(join(root, "missing-image"))) process.exit(1);
  console.log(JSON.stringify([{ Id: "sha256:" + "a".repeat(64), Os: "linux", Architecture: "arm64" }]));
} else if (command === "run") {
  const name = value("--name"), path = join(root, "containers", name);
  const id = labels.find(label => label.startsWith(RUN_LABEL + "="))!.split("=")[1]!;
  const record = { args, labels, pid: process.pid, childPid: undefined as number | undefined, id, name, snapshot: value("--mount").match(/src=(.*),dst=/)![1] };
  writeFileSync(path + ".tmp", JSON.stringify(record)); renameSync(path + ".tmp", path);
  const mode = args.at(-1);
  if (mode === "hold-child") {
    const child = Bun.spawn([process.execPath, "-e", "process.once('SIGUSR1', () => process.exit(0)); console.log('child-ready'); setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
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
} else if (command === "ps") {
  if (existsSync(join(root, "cleanup-off"))) process.exit(1);
  if (existsSync(join(root, "remove-attempted"))) {
    writeFileSync(join(root, "removal-observed"), "listed during removal");
    if (existsSync(join(root, "finish-removal"))) for (const name of readdirSync(join(root, "containers"))) rmSync(join(root, "containers", name), { force: true });
  }
  const filters = args.flatMap((word, index) => word === "--filter" ? [args[index + 1]!.slice("label=".length)] : []);
  for (const name of readdirSync(join(root, "containers")).filter(name => !name.endsWith(".tmp"))) {
    const entry = JSON.parse(readFileSync(join(root, "containers", name), "utf8"));
    if (filters.every(filter => entry.labels.includes(filter))) console.log(name);
  }
} else if (command === "stop" || command === "rm") {
  if (existsSync(join(root, "cleanup-off"))) process.exit(1);
  if (existsSync(join(root, "removal-pending"))) {
    if (command === "rm") { writeFileSync(join(root, "remove-attempted"), "removal requested"); console.error("Removal already in progress"); process.exit(1); }
    process.exit(0);
  }
  rmSync(join(root, "containers", args.at(-1)!), { force: true });
} else throw new Error("Unsupported fake operation: " + args.join(" "));
