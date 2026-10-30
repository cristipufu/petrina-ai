import { afterAll, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtraValidation } from "@petrina/core";
import { localFiles } from "@petrina/platform/file-operations";
import { CLEANUP_MS } from "@petrina/test-support/commands";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";
import { tempDir } from "@petrina/test-support/fixtures";
import { rejectionOf } from "@petrina/test-support/rejections";
import { SLOW } from "@petrina/test-support/slow";
import { ExtraContainer, nativeContainerInspection } from "../../../src/extra-container.js";
import { scriptedContainerInspection } from "../../fixtures/container-inspection.js";

const root = tempDir("petrina-container-inspection-");
registerFixtureRoot(root);
const owner = new FixtureOperations({ label: `Container metadata at ${root}`, stop() {},
  dispose: () => rmSync(root, { recursive: true, force: true }), allowanceMs: CLEANUP_MS * SLOW,
  arm: (expired, ms) => { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); } });
afterAll(() => owner.close());

// A queued request has no execution or version evidence; prepare only observes service metadata.
const request: ExtraValidation = { id: "inspection", requestId: "inspection", taskId: "task", productId: "product", productName: "Private product",
  repository: "private", source: "unused", name: "Inspect metadata", reason: "Native adapter contract", image: "local:ready", argv: ["probe"],
  commit: "", tree: "", versionNote: "No repository operation requested", workingEdits: false, host: { system: process.platform, arch: process.arch },
  containerName: "unused", owner: "fixture", snapshot: join(root, "unused-snapshot"), state: "queued", queuedAt: 0, queueOrder: 1 };
const calls = (folder: string) => readFileSync(join(folder, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line));

it("matches native metadata with explicit private observations, including unavailable and remote services", () => owner.run(async () => {
  for (const state of ["ready", "offline", "remote", "missing-image"] as const) {
    const native = join(root, state, "native"), scripted = join(root, state, "scripted");
    mkdirSync(native, { recursive: true }); mkdirSync(scripted, { recursive: true });
    if (state !== "ready") for (const folder of [native, scripted]) writeFileSync(join(folder, state), "Supplied service state");
    const tool = [process.execPath, join(import.meta.dir, "../../fake-extra-container.ts"), native];
    const inProcess = scriptedContainerInspection(scripted);
    expect(existsSync(join(scripted, "calls"))).toBe(false);
    // A successful prepare must forward the discovered canonical endpoint to both effects.
    expect(String(await rejectionOf(inProcess.service("unix:///another-service")))).toContain("unknown service endpoint");
    expect(String(await rejectionOf(inProcess.image("unix:///another-service", request.image)))).toContain("unknown service endpoint");
    expect(existsSync(join(scripted, "calls"))).toBe(false);
    const hosts = [new ExtraContainer({ dataDir: join(native, "data"), files: localFiles, options: { containerTool: tool } }),
      new ExtraContainer({ dataDir: join(scripted, "data"), files: localFiles, options: { containerTool: tool, containerInspection: inProcess } })];
    if (state === "ready") {
      const actual = await hosts[0]!.prepare(request), supplied = await hosts[1]!.prepare(request);
      expect(supplied).toEqual(actual);
      expect(actual).toEqual({ tool: JSON.stringify(tool), endpoint: "unix:///private-fake-service", service: "Private service (29.9)",
        imageId: "sha256:" + "a".repeat(64), os: "linux", arch: "arm64" });
    } else {
      const nativeError = await rejectionOf(hosts[0]!.prepare(request)), scriptedError = await rejectionOf(hosts[1]!.prepare(request));
      expect(nativeError).toBeInstanceOf(Error); expect(scriptedError).toBeInstanceOf(Error);
      if (state === "remote") {
        expect(String(nativeError)).toContain("remote execution is refused");
        expect(String(scriptedError)).toContain("remote execution is refused");
      }
      if (state === "offline") {
        expect(String(nativeError)).toContain("Private service unavailable");
        expect(String(scriptedError)).toContain("Private service unavailable");
      }
    }
    expect(calls(scripted)).toEqual(calls(native));
    expect(calls(native)).toEqual(state === "offline" || state === "remote" ? [["context", "inspect"]]
      : [["context", "inspect"], ["info", "--format", "{{json .}}"], ["image", "inspect", "--", "local:ready"]]);
    expect(existsSync(request.snapshot)).toBe(false);
    expect(request.run).toBeUndefined();
  }
}));

it("keeps native argv, discovery environment, decoding and command failure at the CLI boundary", () => owner.run(async () => {
  const folder = join(root, "transport"); mkdirSync(folder);
  const journal = join(folder, "transport.jsonl"), reply = join(folder, "reply.json"), cli = join(folder, "metadata.ts");
  writeFileSync(cli, `import { appendFileSync, readFileSync } from 'node:fs';
const [journal, reply, ...args] = process.argv.slice(2);
appendFileSync(journal, JSON.stringify({ args, env: process.env }) + '\\n');
const result = JSON.parse(readFileSync(reply, 'utf8'));
process.stdout.write(result.text); if (result.error) process.stderr.write(result.error); process.exitCode = result.code ?? 0;
`);
  const tool = [process.execPath, cli, journal, reply], config = join(folder, "config ; private"), endpoint = "unix:///private;endpoint";
  const inspection = nativeContainerInspection(tool, config, 4_000 * SLOW);
  const answer = (text: string, code = 0, error = "") => writeFileSync(reply, JSON.stringify({ text, code, error }));
  answer(JSON.stringify([{ Endpoints: { docker: { Host: endpoint } } }]));
  expect(await inspection.contextEndpoint()).toBe(endpoint);
  answer(JSON.stringify({ OSType: "linux", Name: "Local fixture", ServerVersion: "1" }));
  expect(await inspection.service(endpoint)).toEqual({ os: "linux", name: "Local fixture", version: "1" });
  const image = "local:ready ; $(unused)";
  answer(JSON.stringify([{ Id: "sha256:" + "f".repeat(64), Os: "linux", Architecture: "amd64" }]));
  expect(await inspection.image(endpoint, image)).toEqual({ id: "sha256:" + "f".repeat(64), os: "linux", architecture: "amd64" });
  const observed = readFileSync(journal, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(observed.map(entry => entry.args)).toEqual([["context", "inspect"],
    ["--config", config, "--host", endpoint, "info", "--format", "{{json .}}"],
    ["--config", config, "--host", endpoint, "image", "inspect", "--", image]]);
  expect(observed[0].env.HOME).toBe(process.env.HOME);
  expect(observed[0].env.DOCKER_CONFIG).toBe(process.env.DOCKER_CONFIG);
  expect(observed[0].env.DOCKER_CONTEXT).toBe(process.env.DOCKER_CONTEXT);
  for (const entry of observed.slice(1)) {
    expect(entry.env.DOCKER_CONFIG).toBeUndefined(); expect(entry.env.DOCKER_CONTEXT).toBeUndefined(); expect(entry.env.DOCKER_HOST).toBeUndefined();
    expect(entry.env.GIT_CONFIG_GLOBAL).toBeUndefined(); expect(entry.env.PETRINA_HOME).toBeUndefined();
  }
  answer("[]"); expect(await inspection.image(endpoint, image)).toBeUndefined();
  answer("not-json"); expect(await rejectionOf(inspection.service(endpoint))).toBeInstanceOf(SyntaxError);
  answer("", 23, "Private metadata refusal"); expect(String(await rejectionOf(inspection.contextEndpoint()))).toContain("Private metadata refusal");
  const absent = nativeContainerInspection([join(folder, "absent-tool")], config, 4_000 * SLOW);
  expect(await rejectionOf(absent.contextEndpoint())).toBeInstanceOf(Error);
}));
