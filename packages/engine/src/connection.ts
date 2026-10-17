// A product's GitHub connection: the address saved when the product was added, used for every fetch and
// push with the coordinator's login, and one product's credentialed git steps run one at a time (updates
// when a task starts, bringing work up to date, publishing). Products added before Petrina kept their
// address ask the coordinator once.

import type { DeepMutable, Id, Product } from "@petrina/core";
import * as git from "./git.js";
import { Aborted, type Kernel, type MTask } from "./kernel.js";

/** Where credentialed steps go, or why they cannot. `missing`: the product has no GitHub repository at all. */
export type Connection = { ok: true; remote: git.Remote } | { ok: false; reason: string; missing?: boolean };

export type Fetch = { ok: true; sha: string } | { ok: false; error: string; risky?: string[]; timedOut?: boolean; missing?: boolean };

export const CONFIRM_ADDRESS = "Yes, use this address";

/** GitHub could not be asked: never taken for an empty answer. */
export class Unreachable extends Error {}

export class Connections {
  /** Each product's credentialed git steps and publishing steps, one at a time, in the order asked. */
  private readonly lines = new Map<Id, Promise<unknown>>();
  /** A product whose GitHub address the coordinator is being asked to confirm. */
  private readonly confirming = new Map<Id, Promise<void>>();

  constructor(private readonly k: Kernel) {}

  /** One step in the product's line: it starts when the steps before it have finished, whatever they did. */
  serial<T>(productId: Id, step: () => Promise<T>): Promise<T> {
    const next = (this.lines.get(productId) ?? Promise.resolve()).then(step);
    this.lines.set(
      productId,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * The product's GitHub address for credentialed steps: the one saved when it was added. For a product
   * added before Petrina kept it, the coordinator confirms the current address once.
   */
  async connection(task: MTask, signal: AbortSignal): Promise<Connection> {
    for (;;) {
      const product = this.k.productOf(task);
      const name = product?.name ?? "This product";
      if (!product?.path || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(product.repo) || product.repo.startsWith("local/")) return { ok: false, reason: `${name} has no GitHub repository`, missing: true };
      if (product.remote) return this.remoteFor(product, product.remote);
      const pending = this.confirming.get(product.id);
      if (pending) {
        await pending.catch(() => undefined);
        if (signal.aborted) throw new Aborted();
        continue;
      }
      // Claimed before anything is read, so tasks starting together ask once between them.
      const asking = this.confirmAddress(task, product.id, signal);
      this.confirming.set(
        product.id,
        asking.then(() => undefined),
      );
      try {
        const stopped = await asking;
        if (stopped) return stopped;
      } finally {
        this.confirming.delete(product.id);
      }
    }
  }

  /** The saved address, for a delivery whose connection was already in use: nothing needs confirming. */
  savedRemote(task: MTask): git.Remote {
    const product = this.k.productOf(task)!;
    const connection = product.remote ? this.remoteFor(product, product.remote) : undefined;
    if (!connection?.ok) throw new Error(connection?.reason ?? `${product.name} has no saved GitHub address`);
    return connection.remote;
  }

  async requireConnection(task: MTask, signal: AbortSignal): Promise<git.Remote> {
    const connection = await this.connection(task, signal);
    if (!connection.ok) throw new Error(`Petrina published nothing: ${connection.reason}. Delivering to main in this repository still works.`);
    return connection.remote;
  }

  /** Fetch the default branch from the saved address, in the product's line, right after checking the repository's settings. */
  async fetchDefault(task: MTask, signal: AbortSignal): Promise<Fetch> {
    const product = this.k.productOf(task)!;
    const connection = await this.connection(task, signal);
    if (!connection.ok) return { ok: false, error: connection.reason, ...(connection.missing ? { missing: true } : {}) };
    return this.serial(product.id, () => git.fetchBranch(product.path!, connection.remote, product.defaultBranch ?? "main"));
  }

  /** Why a fetch did not happen, in plain words. */
  why(task: MTask, fetched: Extract<Fetch, { ok: false }>): string {
    if (fetched.risky) return `the repository's git settings include ${fetched.risky.slice(0, 3).join(", ")}, which could misuse your GitHub login`;
    if (fetched.timedOut) return "GitHub did not answer in time";
    return fetched.error || `${this.k.productOf(task)?.name ?? "the product"} could not be reached`;
  }

  /** A saved address, used only when it is the product's repository on GitHub. Tests stand in a folder for GitHub. */
  private remoteFor(product: DeepMutable<Product>, address: string): Connection {
    if (!git.sameRepo(address, product.repo)) return { ok: false, reason: `${product.name}'s address ${address} is not ${product.repo} on GitHub` };
    // Older GitHub clones may use HTTP or the read-only git protocol; use HTTPS for both fetch and
    // delivery rather than enabling those transports, keeping the saved repository and origin unchanged.
    return { ok: true, remote: this.k.options.remote ? { url: this.k.options.remote, local: true } : { url: /^(?:http|git):\/\//i.test(address) ? `https://github.com/${product.repo}.git` : address } };
  }

  /** Show the coordinator the address the clone has now; the answer is kept. A connection that cannot be used comes back as is. */
  private async confirmAddress(task: MTask, productId: Id, signal: AbortSignal): Promise<Connection | undefined> {
    const product = this.k.s.products.find((entry) => entry.id === productId)!;
    const name = product.name;
    const address = await git.remoteAddress(product.path!);
    if (!address) return { ok: false, reason: `${name} has no GitHub address`, missing: true };
    if (!git.sameRepo(address, product.repo)) return { ok: false, reason: `${name}'s address ${address} is not ${product.repo} on GitHub` };
    if (product.remoteRefused === address) return { ok: false, reason: `you said ${address} is not ${name}'s GitHub address` };
    const id = this.k.raise(task, "question", `Is ${address} the GitHub address of ${name}?`, true, {
      body: `Petrina fetches and publishes ${name} with your GitHub login, only at this address. ${name} was added before Petrina kept its address, so check it once.`,
      options: [CONFIRM_ADDRESS, "No, it is not"],
    });
    task.statusLine = "Waiting for you to confirm the GitHub address";
    this.k.commitNow();
    const answer = await new Promise<string>((resolve, reject) => {
      this.k.waiting.set(id, { resolve, reject });
      signal.addEventListener("abort", () => reject(new Aborted()), { once: true });
    });
    const live = this.k.s.products.find((entry) => entry.id === productId);
    if (!live) return undefined;
    if (answer === CONFIRM_ADDRESS || /^\s*yes\b/i.test(answer)) {
      live.remote = address;
      delete live.remoteRefused;
    } else {
      live.remoteRefused = address;
    }
    this.k.commitNow();
    return undefined;
  }
}
