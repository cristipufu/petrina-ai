// Stands in for the desktop shell: starts an app-mode engine, passes on its first line, then
// waits until a test kills it outright, the way a crash or a force-quit ends the app.
// bun shell-standin.ts <cli.ts>
const engine = Bun.spawn([process.execPath, process.argv[2]!, "app"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
const reader = engine.stdout.getReader();
let text = "";
while (!text.includes("\n")) {
  const { value, done } = await reader.read();
  if (done) break;
  text += new TextDecoder().decode(value);
}
process.stdout.write(text.split("\n")[0] + "\n");
setInterval(() => undefined, 60_000);

export {};
