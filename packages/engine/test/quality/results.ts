import { isAbsolute, join, relative } from "node:path";
const decode = (value: string): string => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity]!);

/** Read only the installed runners' structured file outcomes; terminal labels cannot establish attribution. */
export function failedFiles(body: string, workspace: string, runner: "bun" | "vitest", root: string): string[] {
  const normalize = (file: string) => (isAbsolute(file) ? relative(root, file) : join(workspace, file)).replaceAll("\\", "/");
  if (runner === "vitest") {
    const report = JSON.parse(body);
    if (!Array.isArray(report.testResults) || !report.testResults.length) throw new Error("Missing Vitest file outcomes");
    const failures = report.testResults.filter((file: { status: string }) => file.status === "failed").map((file: { name: string }) => normalize(file.name));
    if (report.success === false && !failures.length) throw new Error("Vitest failed without attributable file outcomes");
    return [...new Set<string>(failures)].sort();
  }
  // Bun's nested describe suites can repeat a file. Reject unrecognised reports rather than
  // guessing success from an empty result; keep original XML beside the observation.
  const suites = [...body.matchAll(/<testsuite\b([^>]*)>[\s\S]*?<\/testsuite>/g)];
  if (!body.includes("<testsuites ") || !suites.length) throw new Error("Missing Bun file outcomes");
  const failures = suites.flatMap(suite => {
    const attributes = new Map([...suite[1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1]!, decode(match[2]!)]));
    const file = attributes.get("file"), failures = Number(attributes.get("failures")), errors = Number(attributes.get("errors") ?? "0");
    if (!file || !Number.isFinite(failures) || !Number.isFinite(errors)) throw new Error("Incomplete Bun file outcome");
    return failures + errors > 0 ? [normalize(file)] : [];
  });
  if (Number(body.match(/<testsuites\b[^>]*\bfailures="(\d+)"/)?.[1] ?? "0") > 0 && !failures.length) throw new Error("Bun failed without attributable file outcomes");
  return [...new Set(failures)].sort();
}
