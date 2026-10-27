interface WorldOwner {
  /** Register before invoking the starter, including its synchronous failure. */
  prepare(start: () => Promise<void>): Promise<void>;
  stopAll(): Promise<void>;
  close(): Promise<void>;
}

/** Peer release belongs to the root's bounded close; waiting on it again would bypass that bound. */
export function nativeWorldLifetime(owner: WorldOwner, stopPeers?: () => void | Promise<void>) {
  let closed = false, peers: Promise<void> | undefined, closing: Promise<void> | undefined;
  const requestPeers = () => {
    if (peers) return peers;
    if (!stopPeers) return peers = Promise.resolve();
    let done!: () => void, failed!: (error: unknown) => void;
    peers = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
    // A peer may synchronously reenter close; publish its identity before starting it.
    void owner.prepare(async () => { await stopPeers(); }).then(done, failed);
    return peers;
  };
  const request = () => { void requestPeers().catch(() => undefined); };
  return {
    get closed() { return closed; },
    stop(): Promise<void> {
      closed = true;
      request();
      return owner.stopAll();
    },
    close(): Promise<void> {
      if (closing) return closing;
      let done!: () => void, failed!: (error: unknown) => void;
      closing = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
      closed = true;
      request();
      void owner.close().then(done, failed);
      return closing;
    },
  };
}
