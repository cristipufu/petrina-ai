/** Window-local drafts. The workspace subscribes only to presence; composers read the text. */
export class TaskDrafts {
  private readonly text = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private flags: Readonly<Record<string, boolean>> = {};
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  presence = () => this.flags;
  get = (id: string) => this.text.get(id) ?? "";
  set(id: string, value: string): void {
    const previous = this.get(id);
    if (value === previous) return;
    if (value) this.text.set(id, value);
    else this.text.delete(id);
    if (Boolean(value) !== Boolean(previous)) {
      const flags = { ...this.flags };
      if (value) flags[id] = true;
      else delete flags[id];
      this.flags = flags;
    }
    for (const listener of this.listeners) listener();
  }
}
