import { describe, expect, it, vi } from 'vitest';
import { createAuthClient, type TokenSet } from '../../src';
import { flush, localBus, mutexLock, rotatingServer, tokens } from './helpers';

const T0 = 1_000_000;

describe('cross-tab messaging', () => {
  it('tokens set in one tab reach another tab through the channel', async () => {
    const channelName = `tabs-${Math.random()}`;
    const refresh = vi.fn(async () => tokens('never', T0 + 60_000));
    const a = createAuthClient({ refresh, lock: 'none', channel: channelName, now: () => T0 });
    const b = createAuthClient({ refresh, lock: 'none', channel: channelName, now: () => T0 });
    const seenByB: (TokenSet | null)[] = [];
    b.subscribe((t) => seenByB.push(t));

    await a.setTokens(tokens('login', T0 + 60_000));
    await flush();

    expect(await b.getTokens()).toEqual(tokens('login', T0 + 60_000));
    expect(await b.getAccessToken()).toBe('access-login');
    expect(refresh).not.toHaveBeenCalled();
    expect(seenByB).toEqual([tokens('login', T0 + 60_000)]);

    a.dispose();
    b.dispose();
  });

  it('a refresh in one tab is adopted by the others', async () => {
    const bus = localBus();
    const refresh = vi.fn(async () => tokens('fresh', T0 + 60_000));
    const a = createAuthClient({ refresh, lock: 'none', channel: bus(), now: () => T0 });
    const b = createAuthClient({ refresh, lock: 'none', channel: bus(), now: () => T0 });

    await a.getAccessToken();
    expect(await b.getAccessToken()).toBe('access-fresh');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('clear() in one tab clears the others without calling onSessionLost', async () => {
    const bus = localBus();
    const onSessionLost = vi.fn();
    const refresh = vi.fn(async () => tokens('fresh', T0 + 60_000));
    const a = createAuthClient({ refresh, lock: 'none', channel: bus(), now: () => T0 });
    const b = createAuthClient({
      refresh,
      lock: 'none',
      channel: bus(),
      now: () => T0,
      onSessionLost,
    });
    const seenByB: (TokenSet | null)[] = [];
    b.subscribe((t) => seenByB.push(t));

    await a.setTokens(tokens('login', T0 + 60_000));
    await a.clear();

    expect(await b.getTokens()).toBeNull();
    expect(seenByB).toEqual([tokens('login', T0 + 60_000), null]);
    expect(onSessionLost).not.toHaveBeenCalled();
  });

  it('a lost session in one tab logs the others out too', async () => {
    const bus = localBus();
    const lostIn: string[] = [];
    const a = createAuthClient({
      refresh: async () => Promise.reject(new Response(null, { status: 401 })),
      lock: 'none',
      channel: bus(),
      now: () => T0,
      onSessionLost: () => lostIn.push('a'),
    });
    const b = createAuthClient({
      refresh: async () => tokens('unused', T0 + 60_000),
      lock: 'none',
      channel: bus(),
      now: () => T0,
      onSessionLost: () => lostIn.push('b'),
    });
    await b.setTokens(tokens('login', T0 - 1));

    await expect(a.getAccessToken()).rejects.toThrow('Session lost');

    expect(await b.getTokens()).toBeNull();
    expect(lostIn.sort()).toEqual(['a', 'b']);
  });

  it('ignores messages it cannot validate', async () => {
    const channelName = `tabs-${Math.random()}`;
    const refresh = vi.fn(async () => tokens('fresh', T0 + 60_000));
    const client = createAuthClient({ refresh, lock: 'none', channel: channelName, now: () => T0 });
    const rogue = new BroadcastChannel(channelName);

    rogue.postMessage({ type: 'tokens', tokens: { accessToken: 42 } });
    rogue.postMessage('garbage');
    await flush();

    expect(await client.getTokens()).toBeNull();
    rogue.close();
    client.dispose();
  });

  it('five tabs with a shared lock and a broadcast channel survive a rotating server', async () => {
    const now = () => T0;
    const server = rotatingServer(now);
    const lock = mutexLock();
    const bus = localBus();
    const lost: string[] = [];
    const tabs = ['a', 'b', 'c', 'd', 'e'].map((name) =>
      createAuthClient({
        refresh: server.refresh,
        storage: 'memory',
        lock,
        channel: bus(),
        now,
        onSessionLost: () => lost.push(name),
      }),
    );

    const results = await Promise.all(tabs.map((tab) => tab.getAccessToken()));

    // The first tab refreshes; the broadcast reaches the others before they get the lock.
    expect(server.calls).toBe(1);
    expect(server.rejected).toBe(0);
    expect(new Set(results)).toEqual(new Set(['access-gen1']));
    expect(lost).toEqual([]);
  });
});
