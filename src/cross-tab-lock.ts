import type { LockOption, RefreshLock, TokenChannel, TokenSet } from './types';

export interface LockConfig {
  name: string;
  leaseTtlMs: number;
  channel: TokenChannel<TokenSet>;
  now(): number;
}

interface Lease {
  owner: string;
  expiresAt: number;
}

export const noLock: RefreshLock = {
  run: (fn) => fn(),
};

export function hasWebLocks(): boolean {
  try {
    return typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';
  } catch {
    return false;
  }
}

function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function';
  } catch {
    return false;
  }
}

/** Exclusive lock through the Web Locks API — the browser releases it if the tab dies mid-refresh. */
export function webLocksLock(name: string): RefreshLock {
  if (!hasWebLocks()) {
    throw new Error('single-flight-auth: the Web Locks API is not available in this environment');
  }
  return {
    run: (fn) => navigator.locks.request(name, { mode: 'exclusive' }, () => fn()),
  };
}

/**
 * Cooperative lease in `localStorage` for browsers without Web Locks. Best effort: `localStorage`
 * has no compare-and-swap, so the acquirer writes its lease, waits a few milliseconds for a
 * concurrent writer to overwrite it, then checks the lease is still its own. A lease that outlives
 * `leaseTtlMs` is treated as abandoned (the holder's tab probably closed).
 */
export function leaseLock(config: LockConfig): RefreshLock {
  const key = `${config.name}:lease`;
  const owner = randomId();

  const read = (): Lease | null => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const lease = parsed as Partial<Lease>;
      return typeof lease.owner === 'string' && typeof lease.expiresAt === 'number'
        ? (lease as Lease)
        : null;
    } catch {
      return null;
    }
  };

  const write = (lease: Lease | null) => {
    try {
      if (lease) localStorage.setItem(key, JSON.stringify(lease));
      else localStorage.removeItem(key);
    } catch {
      // If storage is unusable the lease degrades to in-tab single flight.
    }
  };

  const waitForRelease = (maxMs: number) =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        globalThis.removeEventListener?.('storage', onStorage);
        resolve();
      };
      const onStorage = (event: Event) => {
        if ((event as StorageEvent).key === key) finish();
      };
      const timer = setTimeout(finish, maxMs);
      const unsubscribe = config.channel.subscribe((message) => {
        if (message.type === 'lease-released' && message.name === config.name) finish();
      });
      globalThis.addEventListener?.('storage', onStorage);
    });

  const acquire = async () => {
    for (;;) {
      const current = read();
      const now = config.now();
      if (!current || current.expiresAt <= now) {
        write({ owner, expiresAt: now + config.leaseTtlMs });
        await sleep(5 + Math.random() * 10);
        if (read()?.owner === owner) return;
      }
      const remaining = current ? Math.max(0, current.expiresAt - config.now()) : 0;
      await waitForRelease(Math.min(50, remaining || 50));
    }
  };

  const release = () => {
    if (read()?.owner === owner) write(null);
    config.channel.post({ type: 'lease-released', name: config.name });
  };

  return {
    async run(fn) {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

export function resolveLock(option: LockOption, config: LockConfig): RefreshLock {
  if (typeof option === 'object') return option;
  const mode = option === 'auto' ? detect() : option;
  switch (mode) {
    case 'web-locks':
      return webLocksLock(config.name);
    case 'lease':
      return leaseLock(config);
    case 'none':
      return noLock;
  }
}

function detect(): 'web-locks' | 'lease' | 'none' {
  if (hasWebLocks()) return 'web-locks';
  if (hasLocalStorage()) return 'lease';
  return 'none';
}

function randomId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return Math.random().toString(36).slice(2);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
