/** Local deliveries own all their destinations together, in order of asking. Nothing is persisted or awaited. */
export class DeliveryTurns {
  private readonly requests = new Map<string, { destinations: readonly string[]; order: number; held: boolean }>();

  constructor(private readonly reserveOrder: () => number) {}

  request(taskId: string, destinations: readonly string[]): { order: number; waitingFor?: string } {
    const keys = [...new Set(destinations)].sort();
    let request = this.requests.get(taskId);
    if (request && JSON.stringify(request.destinations) !== JSON.stringify(keys)) {
      this.requests.delete(taskId);
      request = undefined;
    }
    if (!request) {
      request = { destinations: keys, order: this.reserveOrder(), held: false };
      this.requests.set(taskId, request);
    }
    for (const [otherId, other] of this.requests) {
      if (otherId === taskId) break;
      if (other.destinations.some(key => keys.includes(key))) return { order: request.order, waitingFor: otherId };
    }
    request.held = true;
    return { order: request.order };
  }

  release(taskId: string): void { this.requests.delete(taskId); }

  destinationsFor(taskId: string): readonly string[] | undefined { return this.requests.get(taskId)?.destinations; }

  entries(): readonly { taskId: string; held: boolean }[] {
    return [...this.requests].map(([taskId, request]) => ({ taskId, held: request.held }));
  }
}
