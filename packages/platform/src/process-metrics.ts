// Native observation plans. Callers own execution, deadlines and sampling; these functions never signal a process.
export interface ProcessMetric {
  pid: number;
  ppid: number;
  born: string;
  program: string;
  rssBytes: number;
  /** ps reports a rolling estimate, not an instantaneous CPU counter. */
  cpuPercent?: number;
  cpuMs?: number;
}
export interface ProcessMetricsPlan { argv: string[]; format: "ps" | "windows"; env?: NodeJS.ProcessEnv }

const WINDOWS_PROCESS_METRICS_FIELDS = [
  "pid=$_.ProcessId",
  "ppid=$_.ParentProcessId",
  "born=$(if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('O')} else {''})",
  "program=$_.Name",
  "rssBytes=$_.WorkingSetSize",
  "cpuMs=$(if ($null -ne $_.UserModeTime -and $null -ne $_.KernelModeTime) {([double]$_.UserModeTime+[double]$_.KernelModeTime)/10000} else {$null})",
].join("; ");

const WINDOWS_PROCESS_METRICS_SCRIPT =
  `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ ${WINDOWS_PROCESS_METRICS_FIELDS} } }) | ConvertTo-Json -Compress`;

export function processMetricsPlan(platform: NodeJS.Platform): ProcessMetricsPlan {
  if (platform === "win32") return { format: "windows", argv: ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_METRICS_SCRIPT] };
  if (platform === "darwin" || platform === "linux") return { format: "ps", env: { LC_ALL: "C" }, argv: ["ps", "-axo", "pid=,ppid=,pcpu=,rss=,lstart=,comm="] };
  throw new Error(`Process resource sampling is not implemented for ${platform}.`);
}

export function parseProcessMetrics(text: string, format: ProcessMetricsPlan["format"]): ProcessMetric[] {
  const seen = new Set<number>();
  const numeric = (value: unknown): number => typeof value === "number" ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  const unique = (pid: number): void => { if (seen.has(pid)) throw new Error("Duplicate process identity in observation."); seen.add(pid); };
  if (format === "windows") {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    const rows = Array.isArray(value) ? value : value === null ? [] : [value];
    return rows.flatMap(raw => {
      if (!raw || typeof raw !== "object") throw new Error("Malformed Windows process observation.");
      const row = raw as Record<string, unknown>;
      if (row.pid === 0) return [];
      const pid = numeric(row.pid), ppid = numeric(row.ppid), rssBytes = numeric(row.rssBytes), cpuMs = numeric(row.cpuMs);
      if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0 || !Number.isFinite(rssBytes) || rssBytes < 0 || !Number.isFinite(cpuMs) || cpuMs < 0
        || typeof row.born !== "string" || !/^\d{4}-\d\d-\d\dT/.test(row.born) || !Number.isFinite(Date.parse(row.born)) || typeof row.program !== "string" || !row.program) throw new Error("Incomplete Windows process observation.");
      unique(pid);
      return [{ pid, ppid, born: row.born, program: row.program, rssBytes, cpuMs }];
    });
  }
  return text.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error("Malformed ps process observation.");
    const [, id, parent, cpu, rss, born, command] = match;
    const pid = Number(id), ppid = Number(parent), cpuPercent = Number(cpu), rssBytes = Number(rss) * 1024;
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0 || !Number.isFinite(cpuPercent) || !Number.isSafeInteger(rssBytes)) throw new Error("Invalid ps process observation.");
    unique(pid);
    return { pid, ppid, cpuPercent, rssBytes, born: born!, program: command!.split(/[\\/]/).at(-1)! };
  });
}

/** Retain observed orphans; reject changed birth identities and retire a PID once it disappears.
 * ps birth times have second precision: reuse entirely between two samples can remain indistinguishable.
 */
export class SampledProcessTree {
  private rootBorn: string | undefined;
  private rootEnded = false;
  private readonly known = new Map<number, string>();
  constructor(private readonly root: number) {}

  select(rows: readonly ProcessMetric[]): { rootPresent: boolean; processes: ProcessMetric[] } {
    const byId = new Map(rows.map(row => [row.pid, row]));
    if (byId.size !== rows.length) throw new Error("Duplicate process identity in observation.");
    const root = byId.get(this.root);
    this.rootBorn ??= root?.born;
    const rootPresent = !this.rootEnded && !!root && root.born === this.rootBorn;
    if (this.rootBorn && !rootPresent) this.rootEnded = true;
    const selected = new Set(rootPresent ? [this.root] : []);
    for (const [pid, born] of this.known) { if (pid === this.root) continue; if (byId.get(pid)?.born === born) selected.add(pid); else this.known.delete(pid); }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) if (selected.has(row.ppid) && !selected.has(row.pid)) { selected.add(row.pid); changed = true; }
    }
    const processes = rows.filter(row => selected.has(row.pid));
    for (const row of processes) this.known.set(row.pid, row.born);
    return { rootPresent, processes };
  }
}
