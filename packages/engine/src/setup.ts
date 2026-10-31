/** How to open a web page in the default browser, outside the app. */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === "darwin" ? ["open", url] : platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
}
