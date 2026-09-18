// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ChannelMessage, leaseLock, noLock, webLocksLock } from '../../src';
import { noopChannel } from '../../src/broadcast';
import { type LockConfig, resolveLock } from '../../src/cross-tab-lock';
import { sleep } from './helpers';

const config = (overrides: Partial<LockConfig> = {}): LockConfig => ({
  name: 'test-lock',
  leaseTtlMs: 200,
  channel: noopChannel,
  now: () => Date.now(),
  ...overrides,
});

const LEASE_KEY = 'test-lock:lease';

function stubWebLocks() {
  const request = vi.fn(
    async (_name: string, _options: LockOptions, callback: () => Promise<unknown>) => callback(),
  );
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
  return request;
}

afterEach(() => {
  localStorage.clear();
  Reflect.deleteProperty(navigator, 'locks');
});

describe('leaseLock', () => {
  it('lets one runner through at a time under contention', async () => {
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const locks = Array.from({ length: 8 }, () => leaseLock(config()));

    await Promise.all(
      locks.map((lock, index) =>
        lock.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await sleep(5);
          order.push(index);
          active -= 1;
        }),
      ),
    );

    expect(peak).toBe(1);
    expect(order).toHaveLength(8);
    expect(localStorage.getItem(LEASE_KEY)).toBeNull();
  });

  it('holds the lease while running and removes it afterwards', async () => {
    const lock = leaseLock(config());
    let leaseDuringRun: string | null = null;

    await lock.run(async () => {
      leaseDuringRun = localStorage.getItem(LEASE_KEY);
    });

    expect(leaseDuringRun).not.toBeNull();
    expect(localStorage.getItem(LEASE_KEY)).toBeNull();
  });

  it('releases the lease when the runner throws', async () => {
    const lock = leaseLock(config());
    await expect(lock.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(localStorage.getItem(LEASE_KEY)).toBeNull();
  });

  it('takes over an abandoned lease once it has expired', async () => {
    localStorage.setItem(
      LEASE_KEY,
      JSON.stringify({ owner: 'dead-tab', expiresAt: Date.now() + 60 }),
    );
    const lock = leaseLock(config());
    const started = Date.now();

    await lock.run(async () => {});

    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(localStorage.getItem(LEASE_KEY)).toBeNull();
  });

  it('wakes up when the holder announces the release on the channel', async () => {
    const listeners = new Set<(m: ChannelMessage) => void>();
    const channel: LockConfig['channel'] = {
      post: (m) => {
        for (const l of listeners) l(m);
      },
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      close: () => {},
    };
    localStorage.setItem(
      LEASE_KEY,
      JSON.stringify({ owner: 'other', expiresAt: Date.now() + 10_000 }),
    );
    const lock = leaseLock(config({ channel }));
    let ran = false;
    const running = lock.run(async () => {
      ran = true;
    });

    await sleep(30);
    expect(ran).toBe(false);

    localStorage.removeItem(LEASE_KEY);
    channel.post({ type: 'lease-released', name: 'test-lock' });
    await running;
    expect(ran).toBe(true);
  });

  it('ignores a corrupt lease value', async () => {
    localStorage.setItem(LEASE_KEY, '{nope');
    const lock = leaseLock(config());
    await expect(lock.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('webLocksLock', () => {
  it('requests an exclusive Web Lock with the given name', async () => {
    const request = stubWebLocks();
    const lock = webLocksLock('my-lock');

    await expect(lock.run(async () => 'done')).resolves.toBe('done');

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('my-lock');
    expect(request.mock.calls[0]?.[1]).toEqual({ mode: 'exclusive' });
  });

  it('throws at creation when the API is missing', () => {
    expect(() => webLocksLock('x')).toThrow('Web Locks API is not available');
  });
});

describe('resolveLock', () => {
  it('returns custom locks unchanged and "none" as the pass-through lock', () => {
    const custom = { run: <T>(fn: () => Promise<T>) => fn() };
    expect(resolveLock(custom, config())).toBe(custom);
    expect(resolveLock('none', config())).toBe(noLock);
  });

  it('auto picks Web Locks when available', async () => {
    const request = stubWebLocks();
    await resolveLock('auto', config()).run(async () => {});
    expect(request).toHaveBeenCalled();
  });

  it('auto falls back to the lease when only localStorage exists', async () => {
    let leaseDuringRun: string | null = null;
    await resolveLock('auto', config()).run(async () => {
      leaseDuringRun = localStorage.getItem(LEASE_KEY);
    });
    expect(leaseDuringRun).not.toBeNull();
  });
});
