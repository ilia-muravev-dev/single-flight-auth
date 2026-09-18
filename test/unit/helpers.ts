import type { RefreshContext, RefreshLock, TokenChannel, TokenSet, TokenStorage } from '../../src';

export function tokens(id: string, expiresAt: number): TokenSet {
  return { accessToken: `access-${id}`, expiresAt };
}

/** A `TokenStorage` object that several clients can share, standing in for a shared `localStorage`. */
export function sharedStorage(initial: TokenSet | null = null): TokenStorage & { reads: number } {
  let current = initial;
  return {
    reads: 0,
    get() {
      this.reads += 1;
      return current;
    },
    set(next) {
      current = next;
    },
    clear() {
      current = null;
    },
  };
}

/** An in-memory exclusive lock shared between clients, standing in for the Web Locks API. */
export function mutexLock(): RefreshLock & { maxConcurrency: number } {
  let tail: Promise<unknown> = Promise.resolve();
  let active = 0;
  const lock = {
    maxConcurrency: 0,
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(async () => {
        active += 1;
        lock.maxConcurrency = Math.max(lock.maxConcurrency, active);
        try {
          return await fn();
        } finally {
          active -= 1;
        }
      });
      tail = result.catch(() => undefined);
      return result;
    },
  };
  return lock;
}

/** A synchronous in-process channel: messages reach every other subscriber immediately. */
export function localBus(): () => TokenChannel {
  const members = new Set<{ listeners: Set<(m: unknown) => void> }>();
  return () => {
    const self = { listeners: new Set<(m: unknown) => void>() };
    members.add(self);
    return {
      post(message) {
        for (const member of members) {
          if (member === self) continue;
          for (const listener of member.listeners) listener(message);
        }
      },
      subscribe(listener) {
        self.listeners.add(listener as (m: unknown) => void);
        return () => self.listeners.delete(listener as (m: unknown) => void);
      },
      close() {
        members.delete(self);
      },
    };
  };
}

export interface RotatingServer {
  /** The `refresh` option: behaves like a server that rotates refresh tokens. */
  refresh(context: RefreshContext): Promise<TokenSet>;
  calls: number;
  rejected: number;
  contexts: RefreshContext[];
}

/**
 * Models refresh-token rotation: each refresh consumes the current refresh token and issues a new
 * one. A refresh that started while another one was in flight presents an already-consumed token
 * and is rejected with 401 — exactly what happens when two tabs race.
 */
export function rotatingServer(now: () => number, ttlMs = 60_000, latencyMs = 5): RotatingServer {
  let generation = 0;
  const server: RotatingServer = {
    calls: 0,
    rejected: 0,
    contexts: [],
    async refresh(context) {
      server.calls += 1;
      server.contexts.push(context);
      const presented = generation;
      await sleep(latencyMs);
      if (presented !== generation) {
        server.rejected += 1;
        throw new Response('refresh token already used', { status: 401 });
      }
      generation += 1;
      return tokens(`gen${generation}`, now() + ttlMs);
    },
  };
  return server;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Flushes pending macrotasks so BroadcastChannel deliveries settle. */
export function flush(): Promise<void> {
  return sleep(15);
}
