import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ExtraValidation } from "@petrina/core";
import type { Kernel } from "./kernel.js";
import * as git from "./git.js";
import { processList } from "@petrina/platform/process-tree";

export const OWNER_LABEL = "app.petrina.validation-owner";
export const RUN_LABEL = "app.petrina.validation-run";
type ClientProcess = { pid: number; group: number; state: string; command: string; started?: string };

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

export class ExtraContainer {
  /** Advice only: identities observed beside a verified live leader, never restored from saved numbers. */
  private readonly knownClients = new Map<string, Map<number, ClientProcess>>();
  constructor(private readonly k: Kernel) {}
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
    // Pin a local endpoint; a context pointing at SSH/TCP is unsupported, even if it answers.
    const context = await containerCommand([...tool, "context", "inspect"], this.timeout, true);
    await mkdir(join(this.k.dataDir, "extra-container-config"), { recursive: true, mode: 0o700 });
    const endpoint = JSON.parse(context)[0]?.Endpoints?.docker?.Host as string | undefined;
    const override = process.env.DOCKER_CONTEXT ? undefined : process.env.DOCKER_HOST;
    const host = override ?? endpoint;
    if (!host || !/^(unix:\/\/\/|npipe:\/\/)/.test(host)) throw new Error("Only a local Linux container service is supported; remote execution is refused.");
    const prefix = [...tool, "--config", join(this.k.dataDir, "extra-container-config"), "--host", host];
    const info = JSON.parse(await containerCommand([...prefix, "info", "--format", "{{json .}}"], this.timeout));
    if (info.OSType !== "linux") throw new Error("The container service must run Linux containers.");
    const image = JSON.parse(await containerCommand([...prefix, "image", "inspect", "--", record.image], this.timeout))[0];
    if (image?.Os !== "linux" || !/^sha256:[a-f0-9]{64}$/.test(image?.Id ?? "") || !image.Architecture)
      throw new Error("That local Linux image is unavailable. Prepare it first; Petrina never downloads images.");
    return { tool: JSON.stringify(tool), endpoint: host, service: `${info.Name ?? "Local container service"} (${info.ServerVersion ?? "version unreported"})`,
      imageId: image.Id, os: image.Os, arch: image.Architecture };
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

  private async labelled(record: ExtraValidation, timeout = this.timeout): Promise<string[]> {
    const output = await containerCommand(this.command(record, ["ps", "--all", "--filter", `label=${OWNER_LABEL}=${record.owner}`,
      "--filter", `label=${RUN_LABEL}=${record.id}`, "--format", "{{.Names}}"]), timeout);
    const names = output.split(/\s+/).filter(Boolean);
    if (names.some(name => name !== record.containerName)) throw new Error("An unexpected owned container needs cleanup confirmation.");
    return names;
  }

  /** --rm may still be removing a stopped container. Admit reads for one service allowance;
   * each admitted read retains its normal allowance, even near the end of that window. */
  private async removed(record: ExtraValidation): Promise<boolean> {
    const deadline = Date.now() + this.timeout;
    for (;;) {
      if (Date.now() >= deadline) return false;
      try { if (!(await this.labelled(record)).length) return true; }
      catch (error) { if (Date.now() >= deadline) return false; throw error; }
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await Bun.sleep(Math.min(50, left));
    }
  }

  /** Verify the exact random name in the client's command before signalling its process group. */
  private async stopClient(record: ExtraValidation): Promise<boolean> {
    if (process.platform === "win32") return false; // This bounded mode currently needs Unix process groups.
    const read = () => processList(["-A", "-o", "pid=,pgid=,stat=,lstart=,command="], this.timeout, undefined, { ...process.env, LC_ALL: "C" });
    const list = await read();
    if (list === undefined) {
      record.cleanupDetail = "Petrina could not inspect the local client programs. Restore process-list access so Petrina can confirm they stopped.";
      return false;
    }
    const parse = (list: string): ClientProcess[] => list.split("\n").flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
      if (!match) return [];
      const identity = match[4]?.match(/^(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})(?:\s+(.+))?$/);
      return [{ pid: Number(match[1]), group: Number(match[2]), state: match[3]!, command: identity ? identity[2] ?? "" : match[4] ?? "",
        ...(identity ? { started: identity[1]!.replace(/\s+/g, " ") } : {}) }];
    });
    const isClient = (row: ClientProcess) => row.command.includes(`--name ${record.containerName} `) && row.command.includes(`${RUN_LABEL}=${record.id} `);
    const remember = (rows: ClientProcess[]) => {
      const groups = new Set(rows.filter(row => row.pid === row.group && !row.state.startsWith("Z") && isClient(row)).map(row => row.group));
      if (!groups.size) return;
      const known = this.knownClients.get(record.id) ?? new Map<number, ClientProcess>();
      for (const row of rows) if (groups.has(row.group) && row.started && row.command) known.set(row.pid, row);
      this.knownClients.set(record.id, known);
    };
    const rows = parse(list);
    const clients = rows.filter(isClient);
    remember(rows);
    for (const client of clients) {
      if (client.pid !== client.group) return false;
      try { process.kill(-client.group, "SIGKILL"); } catch { /* Confirm below, with current identity before any stop advice. */ }
    }
    const knownGroups = [...(this.knownClients.get(record.id)?.values() ?? [])].map(row => row.group);
    const groups = new Set([...(record.clientPid ? [record.clientPid] : []), ...clients.map(row => row.group), ...knownGroups]);
    // A saved group number alone proves no ownership: it may have been reused while Petrina was down.
    const after = await read();
    const observed = after === undefined ? undefined : parse(after);
    if (observed) {
      remember(observed);
      for (const row of observed.filter(isClient)) groups.add(row.group);
    }
    const live = observed?.filter(row => groups.has(row.group) && !row.state.startsWith("Z"));
    const verified = new Set(live?.filter(row => row.pid === row.group && isClient(row)).map(row => row.group));
    const known = (row: ClientProcess) => {
      const previous = this.knownClients.get(record.id)?.get(row.pid);
      return row.started !== undefined && row.started === previous?.started && row.group === previous.group && row.command === previous.command;
    };
    if (!live || live.length) record.cleanupDetail = live?.length
      ? live.every(row => verified.has(row.group))
        ? `Petrina's verified local client for extra validation “${record.name}” and its helpers are still running. Stop that named client and its helpers; Petrina will confirm cleanup before releasing checks.`
        : live.every(row => verified.has(row.group) || known(row))
          ? `Petrina's verified local helpers (${live.map(row => row.pid).join(", ")}) for extra validation “${record.name}” are still running. Stop those owned programs; Petrina will confirm cleanup before releasing checks.`
        : "Petrina cannot verify whether programs using the saved client process group belong to this run; they may be unrelated. Do not stop programs based on the saved number. Checks stay held until their absence can be confirmed. Save your work and restart this computer if the uncertainty persists; Petrina will retry confirmation."
      : "Petrina could not inspect the local client programs. Restore process-list access so Petrina can confirm they stopped.";
    if (live?.length === 0) this.knownClients.delete(record.id);
    return live !== undefined && live.length === 0;
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
          await containerCommand(this.command(record, ["stop", "--timeout", "2", record.containerName]), this.timeout).catch(() => undefined);
          if ((await this.labelled(record)).length)
            await containerCommand(this.command(record, ["rm", "--force", record.containerName]), this.timeout).catch(() => undefined);
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
