import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { containerContextEndpoint, containerImageInfo, containerServiceInfo, type ContainerInspection } from "../../src/container-inspection.js";
import { containerNames, type ContainerControl, type ContainerTarget } from "../../src/container-control.js";
import { OWNER_LABEL, RUN_LABEL } from "../../src/extra-container.js";

/** One private service protocol for the CLI and explicit service effects. Workload clients stay native. */
export function privateContainerCall(root: string, args: readonly string[]): string | undefined {
  for (const directory of ["containers", "creating", "started", "release"]) mkdirSync(join(root, directory), { recursive: true });
  appendFileSync(join(root, "calls"), JSON.stringify(args) + "\n");
  if (existsSync(join(root, "offline"))) throw new Error("Private service unavailable");
  if (args[0] === "context") return JSON.stringify([{ Endpoints: { docker: { Host: existsSync(join(root, "remote")) ? "ssh://elsewhere" : "unix:///private-fake-service" } } }]);
  if (args[0] === "info") return JSON.stringify({ OSType: "linux", Name: "Private service", ServerVersion: "29.9" });
  if (args[0] === "image") {
    if (existsSync(join(root, "missing-image"))) throw new Error("");
    return JSON.stringify([{ Id: "sha256:" + "a".repeat(64), Os: "linux", Architecture: "arm64" }]);
  }
  if (args[0] === "ps") {
    if (existsSync(join(root, "cleanup-off"))) throw new Error("");
    if (existsSync(join(root, "remove-attempted"))) {
      writeFileSync(join(root, "removal-observed"), "listed during removal");
      if (existsSync(join(root, "finish-removal"))) for (const name of readdirSync(join(root, "containers"))) rmSync(join(root, "containers", name), { force: true });
    }
    const filters = args.flatMap((word, index) => word === "--filter" ? [args[index + 1]!.slice("label=".length)] : []);
    return readdirSync(join(root, "containers")).filter(name => !name.endsWith(".tmp")).filter(name => {
      const entry = JSON.parse(readFileSync(join(root, "containers", name), "utf8"));
      return filters.every(filter => entry.labels.includes(filter));
    }).join("\n");
  }
  if (args[0] === "stop" || args[0] === "rm") {
    if (existsSync(join(root, "cleanup-off"))) throw new Error("");
    if (existsSync(join(root, "removal-pending"))) {
      if (args[0] === "rm") { writeFileSync(join(root, "remove-attempted"), "removal requested"); throw new Error("Removal already in progress"); }
      return "";
    }
    rmSync(join(root, "containers", args.at(-1)!), { force: true });
    return "";
  }
  return undefined;
}

/** Same state, filtering and control effects as the private CLI, without a process just to return that data. */
export function scriptedContainerControl(root: string, expectedOwner: () => string): ContainerControl {
  const call = (target: ContainerTarget, args: readonly string[]) => {
    if (target.endpoint !== "unix:///private-fake-service" || target.owner !== expectedOwner()
      || !/^[a-zA-Z0-9-]+$/.test(target.runId) || target.name !== `petrina-extra-${target.runId}`)
      throw new Error("The private container control received another service or owner");
    const reply = privateContainerCall(root, args);
    if (reply === undefined) throw new Error("The private service has no control reply for this operation");
    return reply;
  };
  return {
    list: async target => containerNames(call(target, ["ps", "--all", "--filter", `label=${OWNER_LABEL}=${target.owner}`,
      "--filter", `label=${RUN_LABEL}=${target.runId}`, "--format", "{{.Names}}"])),
    stop: async target => { call(target, ["stop", "--timeout", "2", target.name]); },
    remove: async target => { call(target, ["rm", "--force", target.name]); },
  };
}

/** Explicit metadata observations from the same private service state consumed by its CLI. */
export function scriptedContainerInspection(root: string): ContainerInspection {
  const requireEndpoint = (endpoint: string) => {
    if (endpoint !== "unix:///private-fake-service") throw new Error("The private metadata provider received an unknown service endpoint");
  };
  const read = (args: readonly string[]) => {
    const text = privateContainerCall(root, args);
    if (text === undefined) throw new Error("The private service has no metadata reply for this operation");
    return text;
  };
  return {
    contextEndpoint: async () => containerContextEndpoint(read(["context", "inspect"])),
    service: async endpoint => { requireEndpoint(endpoint); return containerServiceInfo(read(["info", "--format", "{{json .}}"])); },
    image: async (endpoint, image) => { requireEndpoint(endpoint); return containerImageInfo(read(["image", "inspect", "--", image])); },
  };
}
