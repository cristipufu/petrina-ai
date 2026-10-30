/** A single owned workload at its already approved local service. */
export interface ContainerTarget {
  readonly endpoint: string;
  readonly name: string;
  readonly owner: string;
  readonly runId: string;
}

/** Service control only; local client processes and workload execution have separate native owners. */
export interface ContainerControl {
  list(target: ContainerTarget, timeoutMs: number): Promise<readonly string[]>;
  stop(target: ContainerTarget, timeoutMs: number): Promise<void>;
  remove(target: ContainerTarget, timeoutMs: number): Promise<void>;
}

export const containerNames = (text: string): string[] => text.split(/\s+/).filter(Boolean);
