import {describe,expect,it} from "bun:test";
import {detectTerminals,pickTerminal,type Platform,type Probe} from "../../../src/terminal-plan.js";

describe("the usual terminal on each system", () => {
  const probe = (platform: Platform, programs: string[], files: string[] = [], env: Record<string, string> = {}): Probe => ({
    platform,
    env,
    home: "/Users/ana",
    which: (program) => (programs.includes(program) ? (platform === "win32" ? `C:\\Windows\\${program}.exe` : `/usr/bin/${program}`) : null),
    exists: (path) => files.includes(path),
  });

  it("macOS: Terminal first, then iTerm2 and the other installed ones", () => {
    const found = detectTerminals(probe("darwin", [], ["/System/Applications/Utilities/Terminal.app", "/Applications/iTerm.app", "/Users/ana/Applications/Ghostty.app"]));
    expect(found.map((entry) => entry.name)).toEqual(["Terminal", "iTerm2", "Ghostty"]);
    expect(found[0]!.open("/x/open.command")).toEqual(["open", "-a", "/System/Applications/Utilities/Terminal.app", "/x/open.command"]);
    expect(found[2]!.open("/x/open.command")).toEqual(["open", "-na", "/Users/ana/Applications/Ghostty.app", "--args", "-e", "/x/open.command"]);
    expect(pickTerminal(found, "iterm")?.name).toBe("iTerm2");
    expect(pickTerminal(found, "warp")?.name).toBe("Terminal");
  });

  it("Windows: Windows Terminal, or else a PowerShell window", () => {
    const withWt = detectTerminals(probe("win32", ["wt", "powershell"]));
    expect(withWt.map((entry) => entry.name)).toEqual(["Windows Terminal", "PowerShell window"]);
    expect(withWt[0]!.open("C:\\p\\open.ps1")).toEqual(["C:\\Windows\\wt.exe", "-w", "new", "C:\\Windows\\powershell.exe", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", "C:\\p\\open.ps1"]);
    const without = detectTerminals(probe("win32", ["powershell"]));
    expect(without.map((entry) => entry.name)).toEqual(["PowerShell window"]);
    expect(without[0]!.ownConsole).toBe(true);
  });

  it("Linux: the system default, then the desktop's own, then common ones; none without a desktop", () => {
    const kde = detectTerminals(probe("linux", ["xterm", "konsole", "gnome-terminal", "x-terminal-emulator"], [], { DISPLAY: ":0", XDG_CURRENT_DESKTOP: "KDE" }));
    expect(kde.map((entry) => entry.id)).toEqual(["x-terminal-emulator", "konsole", "gnome-terminal", "xterm"]);
    expect(kde[1]!.open("/x/open.sh")).toEqual(["/usr/bin/konsole", "-e", "/x/open.sh"]);
    const gnome = detectTerminals(probe("linux", ["xterm", "gnome-terminal"], [], { WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }));
    expect(gnome.map((entry) => entry.id)).toEqual(["gnome-terminal", "xterm"]);
    expect(gnome[0]!.open("/x/open.sh")).toEqual(["/usr/bin/gnome-terminal", "--", "/x/open.sh"]);
    expect(detectTerminals(probe("linux", ["xterm", "gnome-terminal"]))).toEqual([]);
  });
});
