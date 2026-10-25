/** A saved process number never establishes ownership; this observer retains only live identities. */
export interface ValidationClientRecord { id: string; name: string; containerName: string; clientPid?: number; cleanupDetail?: string }
/** Portable facts supplied by a platform adapter; birth identity is opaque to cleanup policy. */
export interface ValidationClientProcess {
  pid: number;
  group: number;
  state: "running" | "defunct";
  command: string;
  birthIdentity?: string;
}
export interface ValidationClientEffects {
  groups: boolean;
  read(): Promise<readonly ValidationClientProcess[] | undefined>;
  killGroup(group: number): void;
}
const RUN_LABEL = "app.petrina.validation-run";
type ClientProcess = ValidationClientProcess;

export class ValidationClientCleanup {
  private readonly knownClients = new Map<string, Map<number, ClientProcess>>();
  constructor(private readonly effects: ValidationClientEffects) {}
  /** Verify the exact random name in the client's command before signalling its process group. */
  async stop(record: ValidationClientRecord): Promise<boolean> {
    if (!this.effects.groups) return false; // This bounded mode currently needs Unix process groups.
    const read = this.effects.read.bind(this.effects);
    const list = await read();
    if (list === undefined) {
      record.cleanupDetail = "Petrina could not inspect the local client programs. Restore process-list access so Petrina can confirm they stopped.";
      return false;
    }
    const isClient = (row: ClientProcess) => row.command.includes(`--name ${record.containerName} `) && row.command.includes(`${RUN_LABEL}=${record.id} `);
    const remember = (rows: readonly ClientProcess[]) => {
      const groups = new Set(rows.filter(row => row.pid === row.group && row.state !== "defunct" && isClient(row)).map(row => row.group));
      if (!groups.size) return;
      const known = this.knownClients.get(record.id) ?? new Map<number, ClientProcess>();
      for (const row of rows) if (groups.has(row.group) && row.birthIdentity && row.command) known.set(row.pid, { ...row });
      this.knownClients.set(record.id, known);
    };
    const rows = list;
    const clients = rows.filter(isClient);
    remember(rows);
    for (const client of clients) {
      if (client.pid !== client.group) return false;
      try { this.effects.killGroup(client.group); } catch { /* Confirm below, with current identity before any stop advice. */ }
    }
    const knownGroups = [...(this.knownClients.get(record.id)?.values() ?? [])].map(row => row.group);
    const groups = new Set([...(record.clientPid ? [record.clientPid] : []), ...clients.map(row => row.group), ...knownGroups]);
    // A saved group number alone proves no ownership: it may have been reused while Petrina was down.
    const after = await read();
    const observed = after;
    if (observed) {
      remember(observed);
      for (const row of observed.filter(isClient)) groups.add(row.group);
    }
    const live = observed?.filter(row => groups.has(row.group) && row.state !== "defunct");
    const verified = new Set(live?.filter(row => row.pid === row.group && isClient(row)).map(row => row.group));
    const known = (row: ClientProcess) => {
      const previous = this.knownClients.get(record.id)?.get(row.pid);
      return row.birthIdentity !== undefined && row.birthIdentity === previous?.birthIdentity && row.group === previous.group && row.command === previous.command;
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

}
