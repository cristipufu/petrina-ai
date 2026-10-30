import { ValidationClientCleanup, confirmContainerRemoval } from "@petrina/orchestrator";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ExtraValidation } from "@petrina/core";
import type { Kernel } from "./kernel.js";
import * as git from "@petrina/repositories/git";
import { readProcessGroupMembers } from "@petrina/platform/process-group-read";
import { containerContextEndpoint, containerImageInfo, containerServiceInfo, type ContainerInspection } from "./container-inspection.js";
import { containerNames, type ContainerControl, type ContainerTarget } from "./container-control.js";

export const OWNER_LABEL = "app.petrina.validation-owner";
export const RUN_LABEL = "app.petrina.validation-run";

/** Only the CLI gets the local service configuration. None of the host environment enters the container. */
export function containerEnv(discovery = false): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, SYSTEMROOT: process.env.SYSTEMROOT,
    ...(discovery ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG, DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT } : {}) };
}

/** Bounded metadata/control calls; never run a shell or pull an image. */
export function containerCommand(argv: readonly string[], timeout: number, discovery = false): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, output = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(output.trim());
    };
    const child = execFile(argv[0]!, [...argv.slice(1)], { env: containerEnv(discovery), timeout, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, output) => finish(error, output));
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("The local container service did not answer in time.")); }, timeout);
  });
}

/** The default transport keeps its bounded CLI commands and discovery environment. */
export function nativeContainerInspection(tool: readonly string[], config: string, timeout: number): ContainerInspection {
  const prefix = (endpoint: string) => [...tool, "--config", config, "--host", endpoint];
  return {
    contextEndpoint: async () => containerContextEndpoint(await containerCommand([...tool, "context", "inspect"], timeout, true)),
    service: async endpoint => containerServiceInfo(await containerCommand([...prefix(endpoint), "info", "--format", "{{json .}}"], timeout)),
    image: async (endpoint, image) => containerImageInfo(await containerCommand([...prefix(endpoint), "image", "inspect", "--", image], timeout)),
  };
}

/** Each native control retains its own bounded command and the approved service endpoint. */
export function nativeContainerControl(tool: readonly string[], config: string): ContainerControl {
  const prefix = (target: ContainerTarget) => [...tool, "--config", config, "--host", target.endpoint];
  return {
    list: async (target, timeout) => containerNames(await containerCommand([...prefix(target), "ps", "--all", "--filter", `label=${OWNER_LABEL}=${target.owner}`,
      "--filter", `label=${RUN_LABEL}=${target.runId}`, "--format", "{{.Names}}"], timeout)),
    stop: async (target, timeout) => { await containerCommand([...prefix(target), "stop", "--timeout", "2", target.name], timeout); },
    remove: async (target, timeout) => { await containerCommand([...prefix(target), "rm", "--force", target.name], timeout); },
  };
}

export class ExtraContainer {
  private readonly clients = new ValidationClientCleanup({
    groups: process.platform !== "win32",
    read: () => readProcessGroupMembers(this.timeout),
    killGroup: group => { process.kill(-group, "SIGKILL"); },
  });
  constructor(private readonly k: Pick<Kernel, "options" | "dataDir" | "files">) {}
  private get timeout(): number { return this.k.options.containerCommandTimeoutMs ?? 4_000; }
  private tool(): readonly string[] {
    if (this.k.options.containerTool) return this.k.options.containerTool;
    const tool = Bun.which("docker");
    if (!tool) throw new Error("The local container tool is not installed.");
    return [tool];
  }
  command(record: ExtraValidation, args: readonly string[]): string[] {
    const tool = record.container?.tool ? JSON.parse(record.container.tool) as string[] : this.tool();
    return [...tool, "--config", join(this.k.dataDir, "extra-container-config"), ...(record.container ? ["--host", record.container.endpoint] : []), ...args];
  }
  async prepare(record: ExtraValidation): Promise<NonNullable<ExtraValidation["container"]>> {
    const tool = this.tool();
    const inspection = this.k.options.containerInspection ?? nativeContainerInspection(tool, join(this.k.dataDir, "extra-container-config"), this.timeout);
    // Pin a local endpoint; a context pointing at SSH/TCP is unsupported, even if it answers.
    const endpoint = await inspection.contextEndpoint();
    await mkdir(join(this.k.dataDir, "extra-container-config"), { recursive: true, mode: 0o700 });
    const override = process.env.DOCKER_CONTEXT ? undefined : process.env.DOCKER_HOST;
    const host = override ?? endpoint;
    if (!host || !/^(unix:\/\/\/|npipe:\/\/)/.test(host)) throw new Error("Only a local Linux container service is supported; remote execution is refused.");
    const info = await inspection.service(host);
    if (info.os !== "linux") throw new Error("The container service must run Linux containers.");
    const image = await inspection.image(host, record.image);
    if (image?.os !== "linux" || !/^sha256:[a-f0-9]{64}$/.test(image?.id ?? "") || !image.architecture)
      throw new Error("That local Linux image is unavailable. Prepare it first; Petrina never downloads images.");
    return { tool: JSON.stringify(tool), endpoint: host, service: `${info.name ?? "Local container service"} (${info.version ?? "version unreported"})`,
      imageId: image.id!, os: image.os, arch: image.architecture };
  }

  async snapshot(record: ExtraValidation): Promise<void> {
    await mkdir(record.snapshot, { recursive: true, mode: 0o755 });
    const run = async (args: string[]) => {
      const result = await git.run(["git", ...args], record.snapshot, undefined, { timeoutMs: 30_000 });
      if (result.code !== 0) throw new Error("Petrina could not prepare the saved repository version.");
    };
    await run(["init", "--quiet", "--template=", ...(record.commit.length === 64 ? ["--object-format=sha256"] : [])]);
    await run(["fetch", "--quiet", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", record.source, record.commit]);
    await run(["checkout", "--quiet", "--detach", record.commit]);
    const exact = await git.commitVersion(record.snapshot);
    if (exact.head !== record.commit || exact.tree !== record.tree || !await git.isClean(record.snapshot))
      throw new Error("The standalone copy does not match the recorded commit and tree.");
  }

  runCommand(record: ExtraValidation): string[] {
    if (!existsSync(record.snapshot)) throw new Error("The saved repository copy is missing.");
    return this.command(record, ["run", "--name", record.containerName,
      "--label", `${OWNER_LABEL}=${record.owner}`, "--label", `${RUN_LABEL}=${record.id}`,
      "--init", "--rm", "--pull=never", "--mount", `type=bind,src=${record.snapshot},dst=/petrina,readonly`, "--workdir", "/petrina",
      "--env", "CI=1", "--env", "GIT_CONFIG_COUNT=2", "--env", "GIT_CONFIG_KEY_0=safe.directory", "--env", "GIT_CONFIG_VALUE_0=/petrina", "--env", "GIT_CONFIG_KEY_1=safe.directory", "--env", "GIT_CONFIG_VALUE_1=/petrina/.git",
      "--entrypoint", record.argv[0]!, record.container!.imageId, ...record.argv.slice(1)]);
  }

  private control(record: ExtraValidation): ContainerControl {
    return this.k.options.containerControl ?? nativeContainerControl(record.container?.tool ? JSON.parse(record.container.tool) as string[] : this.tool(),
      join(this.k.dataDir, "extra-container-config"));
  }

  private target(record: ExtraValidation): ContainerTarget {
    if (!record.container) throw new Error("The owned container service has not been prepared.");
    return { endpoint: record.container.endpoint, name: record.containerName, owner: record.owner, runId: record.id };
  }

  private async labelled(record: ExtraValidation, timeout = this.timeout): Promise<readonly string[]> {
    const names = await this.control(record).list(this.target(record), timeout);
    if (names.some(name => name !== record.containerName)) throw new Error("An unexpected owned container needs cleanup confirmation.");
    return names;
  }

  /** --rm may still be removing a stopped container; each admitted read keeps its normal allowance. */
  private removed(record: ExtraValidation): Promise<boolean> {
    return confirmContainerRemoval(() => this.labelled(record), this.timeout, { now: Date.now, sleep: ms => Bun.sleep(ms) });
  }

  private stopClient(record: ExtraValidation): Promise<boolean> {
    return this.clients.stop(record);
  }

  async cleanup(record: ExtraValidation): Promise<boolean> {
    delete record.cleanupDetail;
    // Even if client confirmation fails, stop the labelled workload. Its absence alone
    // cannot release capacity: an unconfirmed client could still create work afterwards.
    const clientClean = record.startedAt === undefined || await this.stopClient(record);
    let containerClean = true, removalPending = false;
    if (record.container && record.startedAt !== undefined) {
      try {
        if ((await this.labelled(record)).length) {
          await this.control(record).stop(this.target(record), this.timeout).catch(() => undefined);
          if ((await this.labelled(record)).length)
            await this.control(record).remove(this.target(record), this.timeout).catch(() => undefined);
          containerClean = await this.removed(record);
          removalPending = !containerClean;
        }
      } catch { containerClean = false; }
    }
    if (!containerClean) record.cleanupDetail = [record.cleanupDetail,
      removalPending ? `Removal of container ${record.containerName} is still unconfirmed after its stop/removal request. Check that container in the local container service; Petrina will retry confirmation.`
        : `Petrina could not confirm container ${record.containerName} stopped. Make the local container service available, or stop that container; Petrina will retry confirmation.`].filter(Boolean).join(" ");
    if (!clientClean || !containerClean) return false;
    try { await this.k.files.removeTree(record.snapshot); return true; }
    catch {
      record.cleanupDetail = "The workload stopped, but Petrina could not remove its saved copy. Make the extra-validation copy folder accessible so Petrina can remove it.";
      return false;
    }
  }
}
