import { describe, expect, it } from "bun:test";
import { folderPickerCommand, parsePickedFolder, pickLocalFolder } from "../../../src/folder-picker.js";

describe("folderPickerCommand, parsePickedFolder and pickLocalFolder", () => {
  it("builds argument-array native folder dialog commands for macOS, Windows and Linux", () => {
    expect(folderPickerCommand({ platform: "darwin" })).toEqual([
      "osascript",
      "-e",
      'POSIX path of (choose folder with prompt "Choose a repository folder")',
    ]);

    const winCmd = folderPickerCommand({ platform: "win32" });
    expect(winCmd.slice(0, 5)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command"]);
    expect(winCmd[5]).toContain("FolderBrowserDialog");

    expect(
      folderPickerCommand({
        platform: "linux",
        which: (program) => (program === "zenity" ? "/usr/bin/zenity" : null),
      }),
    ).toEqual(["zenity", "--file-selection", "--directory", "--title=Choose a repository folder"]);

    expect(
      folderPickerCommand({
        platform: "linux",
        home: "/home/dev",
        which: (program) => (program === "kdialog" ? "/usr/bin/kdialog" : null),
      }),
    ).toEqual(["kdialog", "--getexistingdirectory", "/home/dev", "--title", "Choose a repository folder"]);

    expect(() => folderPickerCommand({ platform: "linux", which: () => null })).toThrow(
      "No desktop folder dialog is installed on this Linux system.",
    );
  });

  it("normalizes selected paths and maps user cancellations to null", () => {
    expect(
      parsePickedFolder(
        { code: 0, stdout: "/Users/dev/Documents/GitHub/petrina-ai/\n", stderr: "" },
        "darwin",
      ),
    ).toBe("/Users/dev/Documents/GitHub/petrina-ai");
    expect(parsePickedFolder({ code: 0, stdout: "/\n", stderr: "" }, "darwin")).toBe("/");
    expect(
      parsePickedFolder(
        { code: 1, stdout: "", stderr: "36:95: execution error: User canceled. (-128)\n" },
        "darwin",
      ),
    ).toBeNull();

    expect(
      parsePickedFolder(
        { code: 0, stdout: "C:\\Users\\dev\\Documents\\GitHub\\petrina-ai\\\r\n", stderr: "" },
        "win32",
      ),
    ).toBe("C:\\Users\\dev\\Documents\\GitHub\\petrina-ai");
    expect(parsePickedFolder({ code: 0, stdout: "C:\\\r\n", stderr: "" }, "win32")).toBe("C:\\");
    expect(parsePickedFolder({ code: 0, stdout: "\r\n", stderr: "" }, "win32")).toBeNull();

    expect(parsePickedFolder({ code: 1, stdout: "", stderr: "" }, "linux")).toBeNull();
    expect(() => parsePickedFolder({ code: 1, stdout: "", stderr: "WindowServer unavailable" }, "darwin")).toThrow(
      "Petrina could not open a folder window.",
    );
  });

  it("spawns the dialog command, reads normalized stdout and terminates cleanly on abort", async () => {
    const selected = await pickLocalFolder({
      platform: "darwin",
      command: [process.execPath, "-e", 'process.stdout.write("/Users/dev/Documents/Github/petrina-ai/\\n")'],
    });
    expect(selected).toBe("/Users/dev/Documents/Github/petrina-ai");

    const controller = new AbortController();
    const pending = pickLocalFolder({
      platform: "darwin",
      signal: controller.signal,
      command: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
    });
    setTimeout(() => controller.abort(), 30);
    expect(await pending).toBeNull();
  });
});
