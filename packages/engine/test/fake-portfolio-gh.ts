// Route the existing GitHub stand-in to independent local repositories.
import { readFileSync } from "node:fs";
const [file, ...args] = process.argv.slice(2);
const products = JSON.parse(readFileSync(file!, "utf8")) as Record<string, { state: string; remote: string }>;
const repo = args[0] === "repo" && args[1] === "view" && args[2] && !args[2].startsWith("-") ? args[2] : args[0] === "api" ? /^repos\/([^/]+\/[^/]+)\//.exec(args[1] ?? "")?.[1] : args[args.indexOf("--repo") + 1];
const target = products[repo ?? ""] ?? Object.values(products)[0]!;
const processResult = Bun.spawn([process.execPath, `${import.meta.dir}/fake-gh.ts`, target.state, target.remote, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true });
process.exit(await processResult.exited);
