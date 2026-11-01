import { homedir } from "node:os";

export interface FolderPickerPlanOptions {
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly which?: (program: string) => string | null;
  readonly prompt?: string;
}

export interface FolderPickerRunOptions extends FolderPickerPlanOptions {
  readonly signal?: AbortSignal;
  readonly command?: readonly string[];
}

export interface FolderPickerOutput {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const DEFAULT_PROMPT = "Choose a repository folder";

/** Build the argument-array command (no shell) for the operating system's native folder dialog. */
export function folderPickerCommand(options: FolderPickerPlanOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const prompt = (options.prompt ?? DEFAULT_PROMPT).replace(/["\r\n]/g, " ").trim() || DEFAULT_PROMPT;
  const home = options.home ?? homedir();
  const which = options.which ?? ((name: string) => Bun.which(name, { PATH: process.env.PATH ?? "" }));

  if (platform === "darwin") {
    return ["osascript", "-e", `POSIX path of (choose folder with prompt "${prompt}")`];
  }

  if (platform === "win32") {
    const psPrompt = prompt.replace(/'/g, "''");
    const script = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "Add-Type -AssemblyName System.Windows.Forms",
      "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }",
      `$dialog = New-Object System.Windows.Forms.FolderBrowserDialog -Property @{ Description = '${psPrompt}'; ShowNewFolderButton = $false }`,
      "try {",
      "  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {",
      "    [Console]::Out.WriteLine($dialog.SelectedPath)",
      "  }",
      "} finally {",
      "  $owner.Dispose()",
      "  $dialog.Dispose()",
      "}",
    ].join("; ");
    return ["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", script];
  }

  if (which("zenity")) {
    return ["zenity", "--file-selection", "--directory", `--title=${prompt}`];
  }
  if (which("kdialog")) {
    return ["kdialog", "--getexistingdirectory", home, "--title", prompt];
  }
  throw new Error("No desktop folder dialog is installed on this Linux system. Paste the folder path instead.");
}

function normalizeSelectedFolder(raw: string, platform: NodeJS.Platform): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (platform === "win32") {
    if (/^[A-Za-z]:[\\/]$/.test(trimmed)) return `${trimmed.slice(0, 2)}\\`;
    return trimmed.replace(/[\\/]+$/, "");
  }
  if (trimmed === "/") return "/";
  return trimmed.replace(/\/+$/, "");
}

/** Interpret native folder-dialog exit codes and stdout, returning null when cancelled. */
export function parsePickedFolder(
  output: FolderPickerOutput,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (output.code === 0) {
    const normalized = normalizeSelectedFolder(output.stdout, platform);
    return normalized || null;
  }
  if (platform === "darwin" && /user canceled|\(-128\)/i.test(output.stderr)) {
    return null;
  }
  if (platform === "linux" && (output.code === 1 || output.code === 5) && !output.stderr.trim()) {
    return null;
  }
  throw new Error("Petrina could not open a folder window. Paste the folder path instead.");
}

/** Open the operating system's native folder picker and return the chosen path, or null if cancelled. */
export async function pickLocalFolder(options: FolderPickerRunOptions = {}): Promise<string | null> {
  if (options.signal?.aborted) return null;
  const platform = options.platform ?? process.platform;
  const command = options.command ? [...options.command] : folderPickerCommand(options);
  const child = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const onAbort = () => {
    try {
      child.kill();
    } catch {
      // Already exited.
    }
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (options.signal?.aborted) return null;
    return parsePickedFolder({ code, stdout, stderr }, platform);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}
