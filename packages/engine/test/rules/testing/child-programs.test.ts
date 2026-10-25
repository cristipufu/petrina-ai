import { expect, it } from "bun:test";
import { childFixtureBoundaries } from "../../quality/layers.js";
import { conventions } from "../../quality/conventions.js";
import { sourceFacts } from "../../quality/source.js";

const file = "packages/agent-runtime/test/contracts/agents/settings-confirmation.test.ts";
const foreign = "packages/engine/test/fake-agent.ts";
const relative = "../../../../engine/test/fake-agent.ts";
const prelude = `import { join } from 'node:path'; import { AgentRun } from '../../../src/acp-run.js'; const fake = join(import.meta.dir, '${relative}');`;
const sources = (body: string, extra: [string, string][] = []) => new Map([[file, body], [foreign, "export {};"], ...extra]);
const errors = (body: string, extra: [string, string][] = []) => childFixtureBoundaries(file, sourceFacts(body, file).childPrograms, sources(body, extra));

it("detects the actual moved settings contract's const/join/AgentRun child dependency", () => {
  const body = `${prelude} const start = (env) => AgentRun.start({ command: [process.execPath, fake], env });`;
  expect(errors(body)).toEqual([expect.stringContaining(`child fixture ${foreign}`)]);
  expect(conventions(sources(body)).filter(error => error.includes("child fixture"))).toEqual(errors(body));
});

it("recognizes actual Bun, Node and public fixture launch APIs under imported and local aliases", () => {
  for (const launch of [
    "Bun.spawn([process.execPath, fake]);",
    "globalThis.Bun.spawn({ cmd: [process.execPath, fake] });",
    "const launch = Bun.spawn; launch([process.execPath, fake]);",
    "const {spawn: launch} = Bun; launch([process.execPath, fake]);",
    "import { spawn as launch } from 'node:child_process'; launch(process.execPath, [fake]);",
    "import * as child from 'node:child_process'; child.execFile(process.execPath, [fake]);",
    "import child from 'child_process'; child.fork(fake);",
    "import { spawn as launch } from 'bun'; launch([process.execPath, fake]);",
    "import { runCommand as launch } from '@petrina/test-support/commands'; await launch([process.execPath, fake]);",
    "import { runProcess } from '@petrina/test-support/run-process'; await runProcess([process.execPath, fake]);",
    "import * as commands from '@petrina/test-support/commands'; await commands.runCommand([process.execPath, fake]);",
    "Bun.spawn([fake]);",
  ]) expect(errors(`${prelude} ${launch}`)).toEqual([expect.stringContaining(foreign)]);
});

it("follows const argv/options aliases, known spreads and explicit later command fields", () => {
  for (const body of [
    "const command = [process.execPath, fake]; const alias = command; AgentRun.start({ command: alias });",
    "const options = { command: [process.execPath, fake] }; AgentRun.start({ ...options, browser: false });",
    "const options = { command: [process.execPath, fake] }; const alias = options; AgentRun.start(alias);",
    "AgentRun.start({ ...unknown, command: [process.execPath, fake] });",
    "const first = [process.execPath]; AgentRun.start({ command: [...first, fake] });",
    "const options = {command:[process.execPath,fake]}; const {command} = options; AgentRun.start({command});",
    "import {AgentRun as Run} from '@petrina/agent-runtime'; Run.start({command:[process.execPath,fake]});",
    "process.env.PRIVATE_TEST = 'yes'; AgentRun.start({command:[process.execPath,fake]});",
  ]) expect(errors(`${prelude} ${body}`)).toEqual([expect.stringContaining(foreign)]);
});

it("resolves canonical module URLs and path aliases without depending on the host's path spelling", () => {
  for (const setup of [
    `const target = import.meta.resolve('${relative}');`,
    `import { fileURLToPath as local } from 'node:url'; const target = local(import.meta.resolve('${relative}'));`,
    `import { fileURLToPath } from 'node:url'; const target = fileURLToPath(new URL('${relative}', import.meta.url));`,
    `const target = new URL('${relative}', import.meta.url).href;`,
    `import * as paths from 'node:path'; const target = paths.resolve(import.meta.dir, '${relative}');`,
    `import paths from 'path'; const target = paths.join(import.meta.dir, '${relative}');`,
    `const target = join(import.meta.dir, '${relative.replace(/\.ts$/, ".js")}');`,
  ]) expect(errors(`${prelude} ${setup} Bun.spawn([process.execPath, target]);`)).toEqual([expect.stringContaining(foreign)]);
});

it("resolves literal relative executable names only when the launch cwd is itself known", () => {
  for (const launch of [
    `Bun.spawn(['bun', '${relative}'], { cwd: import.meta.dir });`,
    `Bun.spawn({cmd: ['node', '${relative}'], cwd: import.meta.dir});`,
    `AgentRun.start({command: ['bun', '${relative}'], cwd: import.meta.dir});`,
    `import { spawn } from 'node:child_process'; spawn('node', ['${relative}'], {cwd: import.meta.dir});`,
    `import { fork } from 'node:child_process'; fork('${relative}', {cwd: import.meta.dir});`,
  ]) expect(errors(`${prelude} ${launch}`)).toEqual([expect.stringContaining(foreign)]);
  expect(errors(`Bun.spawn(['bun', '${relative}']);`)).toEqual([]);
});

it("accepts own-package peers and public test-support source entrypoints", () => {
  const own = "packages/agent-runtime/test/fixtures/session-agent.ts", shared = "packages/test-support/src/actor.ts";
  for (const target of ["../../fixtures/session-agent.ts", "@petrina/test-support/actor"]) {
    const body = `Bun.spawn([process.execPath, import.meta.resolve('${target}')]);`;
    expect(errors(body, [[own, "export {};"], [shared, "export {};"]])).toEqual([]);
  }
});

it("does not interpret reports, data reads, prose, inline source or later argv entries as executed files", () => {
  const own = "packages/agent-runtime/test/fixtures/session-agent.ts";
  for (const body of [
    "readFileSync(fake); const report = fake;",
    "Bun.spawn(['cat', fake]);",
    "Bun.spawn([process.execPath, '-e', 'console.log(1)', fake]);",
    "Bun.spawn([process.execPath, '--eval', fake]);",
    "Bun.spawn([process.execPath, '--require', fake]);",
    "Bun.spawn(['node', 'run', fake]);",
    "Bun.spawn(['node', 'test', fake]);",
    "Bun.spawn([process.execPath, join(import.meta.dir, '../../fixtures/session-agent.ts'), fake]);",
    "AgentRun.start({ command: [process.execPath, join(import.meta.dir, '../../fixtures/session-agent.ts'), '--report', fake] });",
    "const report = join(import.meta.dir, '../../../../engine/test/report.json'); Bun.spawn(['cat', report]);",
    `const example = \`Bun.spawn([process.execPath, import.meta.resolve('${relative}')]);\`;`,
  ]) expect(errors(`${prelude} ${body}`, [[own, "export {};"], ["packages/engine/test/report.json", "{}"]])).toEqual([]);
});

it("identifies the script position after known Bun/Node flags", () => {
  for (const args of ["'--no-env-file', fake", "'--no-warnings', '--enable-source-maps', fake", "'run', fake", "'test', fake", "'--', fake"])
    expect(errors(`${prelude} Bun.spawn([process.execPath, ${args}]);`)).toEqual([expect.stringContaining(foreign)]);
  expect(errors(`${prelude} Bun.spawn(['node', fake]);`)).toEqual([expect.stringContaining(foreign)]);
  expect(errors(`${prelude} Bun.spawn(['bun', 'run', fake]);`)).toEqual([expect.stringContaining(foreign)]);
});

it("requires actual imported APIs and respects lexical parameter, block and local shadows", () => {
  for (const body of [
    "function check(Bun) { Bun.spawn([process.execPath, fake]); }",
    "function check(process) { Bun.spawn([process.execPath, fake]); }",
    "function check(globalThis) { globalThis.Bun.spawn([process.execPath, fake]); }",
    "function check(join) { const target = join(import.meta.dir, '../../../../engine/test/fake-agent.ts'); Bun.spawn([process.execPath, target]); }",
    "{ const AgentRun = {start(){}}; AgentRun.start({command:[process.execPath,fake]}); }",
    "const launch = localSpawn; launch(process.execPath, [fake]);",
    "import type { spawn } from 'node:child_process'; spawn(process.execPath, [fake]);",
    "import { runCommand } from './local-peer'; runCommand([process.execPath, fake]);",
    "AgentRun.start = fakeStart; AgentRun.start({command:[process.execPath,fake]});",
    "function check() { if (true) { var Bun = fakeBun; } Bun.spawn([process.execPath,fake]); }",
    "class Test { constructor(private process: object) { Bun.spawn([process.execPath,fake]); } }",
    "class Test { #check(Bun) { Bun.spawn([process.execPath,fake]); } }",
    "const Test = class process { check() { Bun.spawn([process.execPath,fake]); } };",
    "enum Bun { spawn }; Bun.spawn([process.execPath,fake]);",
    "Bun.spawn = fakeSpawn; Bun.spawn([process.execPath,fake]);",
    "globalThis.Bun = fakeBun; Bun.spawn([process.execPath,fake]);",
    "process.execPath = otherProgram; Bun.spawn([process.execPath,fake]);",
    "const runtime = Bun; runtime.spawn = localSpawn; Bun.spawn([process.execPath,fake]);",
    "const runtime = globalThis.Bun; (runtime as any).spawn = localSpawn; Bun.spawn([process.execPath,fake]);",
    "import {spyOn} from 'bun:test'; spyOn(Bun,'spawn').mockImplementation(localSpawn); Bun.spawn([process.execPath,fake]);",
    "function mock(root){root.Bun.spawn=localSpawn;} mock(globalThis); Bun.spawn([process.execPath,fake]);",
  ]) expect(errors(`${prelude} ${body}`)).toEqual([]);
});

it("does not claim a static entrypoint after argv/option mutations or unknown later spreads", () => {
  for (const body of [
    "const command = [process.execPath, fake]; command[1] = chosen; Bun.spawn(command);",
    "const command = [process.execPath, fake]; const alias = command; alias.splice(1,1); Bun.spawn(command);",
    "const options = {command:[process.execPath,fake]}; options.command = chosen; AgentRun.start(options);",
    "const options = {command:[process.execPath,fake]}; Object.assign(options,{command:chosen}); AgentRun.start(options);",
    "const options = {command:[process.execPath,fake]}; delete options.command; AgentRun.start(options);",
    "const options = {command:[process.execPath,fake]}; const command = options.command; command[1] = ownPeer; AgentRun.start(options);",
    "const command = [process.execPath,fake]; const options = {command}; const alias = options.command; alias[1] = ownPeer; AgentRun.start({command});",
    "const options = {command:[process.execPath,fake]}; (options as any).command = [process.execPath,ownPeer]; AgentRun.start(options);",
    "function replace(argv){argv[1]=ownPeer;} const command=[process.execPath,fake]; replace(command); Bun.spawn(command);",
    "const options = {command:[process.execPath,fake]}; options.command = chosen; const command = options.command; AgentRun.start({command});",
    "const command=[process.execPath,fake]; const options={command}; unknown(options); AgentRun.start({command});",
    "AgentRun.start({command:[process.execPath,fake], ...unknown});",
    "const options = {command:[process.execPath,fake]}; AgentRun.start({...options, get command(){return chosen;}});",
    "let command = [process.execPath,fake]; command = chosen; Bun.spawn(command);",
  ]) expect(errors(`${prelude} ${body}`)).toEqual([]);
  expect(errors(`${prelude} import { runCommand } from '@petrina/test-support/commands'; runCommand([process.execPath,fake],{start:()=>alreadyOwned});`)).toEqual([]);
  // An escaped mutable container does not make a separate immutable path string unknown.
  expect(errors(`${prelude} const own = []; unknown(own); AgentRun.start({command:[process.execPath,fake]});`)).toEqual([expect.stringContaining(foreign)]);
});

it("leaves private generated files, nonexistent paths and dynamic selections outside the static proof", () => {
  for (const body of [
    "const root = tempDir('private'); const peer = join(root,'peer.ts'); Bun.spawn([process.execPath, peer]);",
    "const peer = join(import.meta.dir, chosen); Bun.spawn([process.execPath, peer]);",
    "const peer = nativeSession(root); AgentRun.start({command:peer.command});",
    "Bun.spawn([process.execPath, import.meta.resolve('../../../../engine/test/not-present.ts')]);",
    "Bun.spawn([process.execPath, join(import.meta.dir,'../../../../../../packages/engine/test/fake-agent.ts')]);",
    `Bun.spawn([process.execPath, import.meta.resolve('${relative}').href]);`,
  ]) expect(errors(body)).toEqual([]);
});

it("checks native helper files too without restricting top-level Engine composition controls", () => {
  const helper = "packages/platform/test/fixtures/launcher.ts", peer = "packages/agent-runtime/test/fixtures/session-agent.ts";
  const body = `Bun.spawn([process.execPath, import.meta.resolve('../../../engine/test/fake-agent.ts')]);`;
  expect(conventions(new Map([[helper, body], [foreign, "export {};"]])).filter(error => error.includes("child fixture"))).toEqual([expect.stringContaining(foreign)]);
  const host = "packages/engine/test/contracts/agents/host.test.ts";
  expect(childFixtureBoundaries(host, [{path:peer,line:1}], new Map([[host,""],[peer,""]]))).toEqual([]);
});
