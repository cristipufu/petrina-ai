import { Engine } from "../engine.js";

/** Global timer interception belongs to this owned child, never the shared test worker. */
async function registration(root: string) {
  const callbacks: (() => void)[] = [], interval = globalThis.setInterval;
  globalThis.setInterval = ((...args: Parameters<typeof globalThis.setInterval>) => {
    if (args[1] === 15_000) callbacks.push(args[0] as () => void);
    return interval(...args);
  }) as typeof globalThis.setInterval;
  let engine: Engine | undefined;
  try {
    engine = new Engine(root, { admissionsClosed: true, agentCommand: () => undefined });
    await engine.waitUntilReady();
    await Promise.all([...engine.backgroundWork]);
    const checkpoint = engine["checkpointStepTimes"].bind(engine);
    let calls = 0;
    engine["checkpointStepTimes"] = () => { calls++; checkpoint(); };
    for (const callback of callbacks) callback();
    await engine.extraValidations.retryCleanup();
    return { checkpointCalls: calls };
  } finally { globalThis.setInterval = interval; await engine?.shutdown(); }
}

async function stoppedScreen(root: string) {
  const engine = new Engine(root, { admissionsClosed: true, agentCommand: () => undefined });
  try {
    await engine.waitUntilReady();
    await Promise.all([...engine.backgroundWork]);
    engine.setPoolPaused(true);
    engine.s.products.push({ id: "p", name: "Product", repo: "local/p", tone: "blue" });
    const task = engine.task(engine.addTask({ productId: "p", title: "A task", backlog: true }))!;
    task.state = "waiting";
    task.screen = { reason: "A window", at: Date.now(), roleId: "builder", profileId: "sol-high", granted: true };
    let release: (() => void) | undefined;
    const timeout = globalThis.setTimeout;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      if (args[1] === 0 && typeof args[0] === "function") { const callback = args[0]; release = () => callback(); }
      return timeout(...args);
    }) as typeof setTimeout;
    try { engine.releaseScreen(task); } finally { globalThis.setTimeout = timeout; }
    const schedule = engine.schedule.bind(engine), screen = engine.syncScreen.bind(engine), commit = engine.commitNow.bind(engine);
    let schedules = 0, screens = 0, commits = 0;
    engine.schedule = () => { schedules++; schedule(); };
    engine.syncScreen = () => { screens++; screen(); };
    engine.commitNow = (...args: Parameters<typeof commit>) => { commits++; commit(...args); };
    await engine.shutdown();
    release?.();
    const schedulesAfterRelease = schedules;
    engine["startupComplete"] = false;
    engine.schedule();
    return { releaseSeen: release !== undefined, schedulesAfterRelease, screens, commits };
  } finally { await engine.shutdown(); }
}

if (import.meta.main) {
  const [kind, root] = process.argv.slice(2);
  if (!root || !["registration", "stopped-screen"].includes(kind ?? "")) throw new Error("Choose an owned timer control and its private root");
  const observation = kind === "registration" ? await registration(root) : await stoppedScreen(root);
  process.stdout.write(JSON.stringify(observation));
}
