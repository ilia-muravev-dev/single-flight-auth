import { describe, expect, it, vi } from 'vitest';
import { createAuthClient, SessionLostError, type TokenSet } from '../../src';
import { mutexLock, rotatingServer, sharedStorage, sleep, tokens } from './helpers';

const T0 = 1_000_000;

function setup(overrides: Partial<Parameters<typeof createAuthClient>[0]> = {}) {
  let nowMs = T0;
  const now = () => nowMs;
  const advance = (ms: number) => {
    nowMs += ms;
  };
  const storage = sharedStorage();
  const refresh = vi.fn(overrides.refresh ?? (async () => tokens('fresh', now() + 60_000)));
  const client = createAuthClient({
    storage,
    lock: 'none',
    channel: false,
    now,
    ...overrides,
    refresh,
  });
  return { client, storage, refresh, now, advance };
}

describe('createAuthClient: getting a token', () => {
  it('rejects a missing refresh function', () => {
    expect(() => createAuthClient({} as never)).toThrow(TypeError);
  });

  it('returns the stored token without refreshing while it is fresh', async () => {
    const { client, storage, refresh } = setup();
    storage.set(tokens('stored', T0 + 60_000));

    expect(await client.getAccessToken()).toBe('access-stored');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes when nothing is stored, with reason "missing"', async () => {
    const { client, refresh } = setup();

    expect(await client.getAccessToken()).toBe('access-fresh');
    expect(refresh).toHaveBeenCalledWith({ previous: null, reason: 'missing' });
  });

  it('refreshes ahead of expiry, inside the skew window, with reason "expired"', async () => {
    const { client, storage, refresh } = setup({ expirySkewMs: 30_000 });
    storage.set(tokens('stale', T0 + 10_000));

    expect(await client.getAccessToken()).toBe('access-fresh');
    expect(refresh).toHaveBeenCalledWith({
      previous: tokens('stale', T0 + 10_000),
      reason: 'expired',
    });
  });

  it('shares a single refresh among concurrent callers', async () => {
    const { client, refresh } = setup({
      refresh: vi.fn(async () => {
        await sleep(10);
        return tokens('fresh', T0 + 60_000);
      }),
    });

    const results = await Promise.all(Array.from({ length: 25 }, () => client.getAccessToken()));

    expect(new Set(results)).toEqual(new Set(['access-fresh']));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refresh() and forceRefresh bypass a fresh token with reason "manual"', async () => {
    const { client, storage, refresh } = setup();
    storage.set(tokens('stored', T0 + 60_000));

    expect(await client.refresh()).toEqual(tokens('fresh', T0 + 60_000));
    await client.getAccessToken({ forceRefresh: true });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith({
      previous: tokens('fresh', T0 + 60_000),
      reason: 'manual',
    });
  });

  it('rejects a refresh result that is not a token set', async () => {
    const { client } = setup({ refresh: vi.fn(async () => ({ token: 'x' }) as never) });
    await expect(client.getAccessToken()).rejects.toThrow(TypeError);
  });

  it('getTokens() reads the stored set without refreshing', async () => {
    const { client, storage, refresh } = setup();
    expect(await client.getTokens()).toBeNull();
    storage.set(tokens('stored', T0 - 1));
    expect(await client.getTokens()).toEqual(tokens('stored', T0 - 1));
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('createAuthClient: fetch', () => {
  function fetchStub(statuses: number[]) {
    const seen: { auth: string | null; body: string; url: string }[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      seen.push({
        auth: request.headers.get('authorization'),
        body: await request.text(),
        url: request.url,
      });
      return new Response('{}', { status: statuses[seen.length - 1] ?? 200 });
    });
    return { fetch: fetch as unknown as typeof globalThis.fetch, seen };
  }

  it('attaches the bearer token', async () => {
    const stub = fetchStub([200]);
    const { client, storage } = setup({ fetch: stub.fetch });
    storage.set(tokens('stored', T0 + 60_000));

    const response = await client.fetch('https://api.example.test/me');

    expect(response.status).toBe(200);
    expect(stub.seen).toEqual([
      { auth: 'Bearer access-stored', body: '', url: 'https://api.example.test/me' },
    ]);
  });

  it('refreshes once and retries once on 401, resending the body', async () => {
    const stub = fetchStub([401, 200]);
    const { client, storage, refresh } = setup({ fetch: stub.fetch });
    storage.set(tokens('stored', T0 + 60_000));

    const response = await client.fetch('https://api.example.test/items', {
      method: 'POST',
      body: JSON.stringify({ name: 'x' }),
    });

    expect(response.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({
      previous: tokens('stored', T0 + 60_000),
      reason: 'unauthorized',
    });
    expect(stub.seen.map((s) => s.auth)).toEqual(['Bearer access-stored', 'Bearer access-fresh']);
    expect(stub.seen.map((s) => s.body)).toEqual(['{"name":"x"}', '{"name":"x"}']);
  });

  it('returns the second 401 instead of looping', async () => {
    const stub = fetchStub([401, 401]);
    const { client, storage, refresh } = setup({ fetch: stub.fetch });
    storage.set(tokens('stored', T0 + 60_000));

    const response = await client.fetch('https://api.example.test/me');

    expect(response.status).toBe(401);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stub.seen).toHaveLength(2);
  });

  it('passes other statuses through untouched', async () => {
    const stub = fetchStub([503]);
    const { client, storage, refresh } = setup({ fetch: stub.fetch });
    storage.set(tokens('stored', T0 + 60_000));

    expect((await client.fetch('https://api.example.test/me')).status).toBe(503);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not retry when retryOn401 is false', async () => {
    const stub = fetchStub([401]);
    const { client, storage, refresh } = setup({ fetch: stub.fetch, retryOn401: false });
    storage.set(tokens('stored', T0 + 60_000));

    expect((await client.fetch('https://api.example.test/me')).status).toBe(401);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('accepts a Request as input and a custom attachToken', async () => {
    const stub = fetchStub([200]);
    const { client, storage } = setup({
      fetch: stub.fetch,
      attachToken: (request, token) => {
        request.headers.set('x-token', token);
        return request;
      },
    });
    storage.set(tokens('stored', T0 + 60_000));

    const input = new Request('https://api.example.test/me', { method: 'PUT', body: 'payload' });
    await client.fetch(input);

    expect(stub.seen[0]?.body).toBe('payload');
    expect(stub.seen[0]?.auth).toBeNull();
    expect((stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBeInstanceOf(Request);
    const sent = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Request;
    expect(sent.headers.get('x-token')).toBe('access-stored');
  });

  it('skips a stale refresh when another tab already replaced the rejected token', async () => {
    const stub = fetchStub([401, 200]);
    const storage = sharedStorage(tokens('old', T0 + 60_000));
    const refresh = vi.fn(async () => tokens('never', T0 + 60_000));
    const client = createAuthClient({
      refresh,
      storage,
      channel: false,
      now: () => T0,
      fetch: stub.fetch,
      lock: {
        // Simulates a tab that refreshed while we were waiting for the lock.
        async run(fn) {
          storage.set(tokens('new', T0 + 60_000));
          return fn();
        },
      },
    });

    const response = await client.fetch('https://api.example.test/me');

    expect(response.status).toBe(200);
    expect(refresh).not.toHaveBeenCalled();
    expect(stub.seen.map((s) => s.auth)).toEqual(['Bearer access-old', 'Bearer access-new']);
  });
});

describe('createAuthClient: failures', () => {
  it('a rejected refresh clears the tokens, notifies once and fails every waiting caller', async () => {
    const onSessionLost = vi.fn();
    const rejection = new Response('nope', { status: 401 });
    const { client, storage, refresh } = setup({
      onSessionLost,
      refresh: vi.fn(async () => {
        await sleep(5);
        throw rejection;
      }),
    });
    storage.set(tokens('stale', T0 - 1));

    const outcomes = await Promise.allSettled([
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
    ]);

    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(SessionLostError);
      expect((outcome as PromiseRejectedResult).reason.cause).toBe(rejection);
    }
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(storage.get()).toBeNull();
    expect(onSessionLost).toHaveBeenCalledTimes(1);
    expect(onSessionLost).toHaveBeenCalledWith(rejection);
  });

  it('a transient refresh failure keeps the tokens and is retried next time', async () => {
    const onSessionLost = vi.fn();
    let attempts = 0;
    const { client, storage } = setup({
      onSessionLost,
      refresh: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('fetch failed');
        return tokens('fresh', T0 + 60_000);
      }),
    });
    storage.set(tokens('stale', T0 - 1));

    await expect(client.getAccessToken()).rejects.toThrow('fetch failed');
    expect(storage.get()).toEqual(tokens('stale', T0 - 1));
    expect(onSessionLost).not.toHaveBeenCalled();

    expect(await client.getAccessToken()).toBe('access-fresh');
  });

  it('recognises { status } and { response: { status } } errors by default', async () => {
    for (const error of [{ status: 403 }, { response: { status: 401 } }]) {
      const { client } = setup({ refresh: vi.fn(async () => Promise.reject(error)) });
      await expect(client.getAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    }
    const { client } = setup({ refresh: vi.fn(async () => Promise.reject({ status: 500 })) });
    await expect(client.getAccessToken()).rejects.not.toBeInstanceOf(SessionLostError);
  });

  it('uses a custom isSessionLost classifier', async () => {
    const { client } = setup({
      refresh: vi.fn(async () => Promise.reject(new Error('invalid_grant'))),
      isSessionLost: (error) => error instanceof Error && error.message === 'invalid_grant',
    });
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(SessionLostError);
  });

  it('notifies onSessionLost again only after new tokens were set', async () => {
    const onSessionLost = vi.fn();
    const { client } = setup({
      onSessionLost,
      refresh: vi.fn(async () => Promise.reject({ status: 401 })),
    });

    await expect(client.getAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    expect(onSessionLost).toHaveBeenCalledTimes(1);

    await client.setTokens(tokens('login', T0 - 1));
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(SessionLostError);
    expect(onSessionLost).toHaveBeenCalledTimes(2);
  });
});

describe('createAuthClient: lifecycle', () => {
  it('notifies subscribers on refresh, setTokens and clear, without duplicates', async () => {
    const { client, storage } = setup();
    const seen: (TokenSet | null)[] = [];
    const unsubscribe = client.subscribe((t) => seen.push(t));

    await client.getAccessToken();
    await client.getAccessToken(); // fresh: no notification
    await client.setTokens(tokens('login', T0 + 60_000));
    await client.setTokens(tokens('login', T0 + 60_000)); // same tokens: no notification
    await client.clear();
    unsubscribe();
    await client.setTokens(tokens('after', T0 + 60_000));

    expect(seen).toEqual([tokens('fresh', T0 + 60_000), tokens('login', T0 + 60_000), null]);
    expect(storage.get()).toEqual(tokens('after', T0 + 60_000));
  });

  it('validates setTokens input', async () => {
    const { client } = setup();
    await expect(client.setTokens({ accessToken: 1 } as never)).rejects.toThrow(TypeError);
  });

  it('keeps working when a subscriber throws', async () => {
    const { client } = setup();
    const second = vi.fn();
    client.subscribe(() => {
      throw new Error('listener bug');
    });
    client.subscribe(second);

    await client.setTokens(tokens('login', T0 + 60_000));
    expect(second).toHaveBeenCalledWith(tokens('login', T0 + 60_000));
  });

  it('refuses to work after dispose', async () => {
    const { client } = setup();
    client.dispose();
    client.dispose();
    await expect(client.getAccessToken()).rejects.toThrow('disposed');
    await expect(client.getTokens()).rejects.toThrow('disposed');
    await expect(client.setTokens(tokens('a', 1))).rejects.toThrow('disposed');
    await expect(client.clear()).rejects.toThrow('disposed');
  });
});

describe('createAuthClient: the race, in one process', () => {
  it('without a lock, two tabs racing a rotating refresh lose the session', async () => {
    const now = () => T0;
    const server = rotatingServer(now);
    const lost: string[] = [];
    const tab = (name: string) =>
      createAuthClient({
        refresh: server.refresh,
        storage: 'memory',
        lock: 'none',
        channel: false,
        now,
        onSessionLost: () => lost.push(name),
      });
    const a = tab('a');
    const b = tab('b');

    const outcomes = await Promise.allSettled([a.getAccessToken(), b.getAccessToken()]);

    expect(server.calls).toBe(2);
    expect(server.rejected).toBe(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
    expect(lost).toHaveLength(1);
  });

  it('with a shared lock and shared storage, the same race costs one refresh and no logouts', async () => {
    const now = () => T0;
    const server = rotatingServer(now);
    const lock = mutexLock();
    const storage = sharedStorage();
    const lost: string[] = [];
    const tab = (name: string) =>
      createAuthClient({
        refresh: server.refresh,
        storage,
        lock,
        channel: false,
        now,
        onSessionLost: () => lost.push(name),
      });
    const a = tab('a');
    const b = tab('b');

    const results = await Promise.all([a.getAccessToken(), b.getAccessToken()]);

    expect(server.calls).toBe(1);
    expect(server.rejected).toBe(0);
    expect(results).toEqual(['access-gen1', 'access-gen1']);
    expect(lock.maxConcurrency).toBe(1);
    expect(lost).toEqual([]);
  });

  it('with a shared lock but per-tab memory, refreshes serialise and nobody is logged out', async () => {
    const now = () => T0;
    const server = rotatingServer(now);
    const lock = mutexLock();
    const lost: string[] = [];
    const tab = (name: string) =>
      createAuthClient({
        refresh: server.refresh,
        storage: 'memory',
        lock,
        channel: false,
        now,
        onSessionLost: () => lost.push(name),
      });
    const a = tab('a');
    const b = tab('b');

    const results = await Promise.all([a.getAccessToken(), b.getAccessToken()]);

    expect(server.calls).toBe(2);
    expect(server.rejected).toBe(0);
    expect(results).toEqual(['access-gen1', 'access-gen2']);
    expect(lost).toEqual([]);
  });
});
