import { resolveChannel } from './broadcast';
import { resolveLock } from './cross-tab-lock';
import { SessionLostError } from './errors';
import { singleFlight } from './single-flight';
import { isTokenSet, resolveStorage } from './storage';
import type {
  AuthClient,
  AuthClientOptions,
  RefreshReason,
  TokenChannel,
  TokenSet,
  TokensListener,
} from './types';

const DEFAULTS = {
  storageKey: 'single-flight-auth:tokens',
  lockName: 'single-flight-auth:refresh',
  channelName: 'single-flight-auth',
  expirySkewMs: 30_000,
  leaseTtlMs: 10_000,
} as const;

export function createAuthClient<T extends TokenSet = TokenSet>(
  options: AuthClientOptions<T>,
): AuthClient<T> {
  if (typeof options?.refresh !== 'function') {
    throw new TypeError('single-flight-auth: `refresh` must be a function');
  }
  const now = options.now ?? (() => Date.now());
  const skew = options.expirySkewMs ?? DEFAULTS.expirySkewMs;
  const retryOn401 = options.retryOn401 ?? true;
  const isSessionLost = options.isSessionLost ?? defaultIsSessionLost;
  const attachToken = options.attachToken ?? defaultAttachToken;
  const storage = resolveStorage<T>(
    options.storage ?? 'memory',
    options.storageKey ?? DEFAULTS.storageKey,
  );
  const channel = resolveChannel<T>(options.channel ?? DEFAULTS.channelName);
  const lock = resolveLock(options.lock ?? 'auto', {
    name: options.lockName ?? DEFAULTS.lockName,
    leaseTtlMs: options.leaseTtlMs ?? DEFAULTS.leaseTtlMs,
    channel: channel as TokenChannel<TokenSet>,
    now,
  });

  const listeners = new Set<TokensListener<T>>();
  let lastEmitted: T | null | undefined;
  let sessionLostNotified = false;
  let disposed = false;

  const isFresh = (tokens: T | null): tokens is T =>
    tokens !== null && tokens.expiresAt - skew > now();

  const emit = (tokens: T | null) => {
    if (sameTokens(tokens, lastEmitted)) return;
    lastEmitted = tokens;
    for (const listener of listeners) {
      try {
        listener(tokens);
      } catch {
        // A throwing listener must not break authentication for the others.
      }
    }
  };

  const assertUsable = () => {
    if (disposed) throw new Error('single-flight-auth: this client has been disposed');
  };

  const adopt = async (tokens: T) => {
    sessionLostNotified = false;
    await storage.set(tokens);
    emit(tokens);
  };

  const loseSession = async (error: unknown, broadcast: boolean) => {
    await storage.clear();
    emit(null);
    if (broadcast) channel.post({ type: 'session-lost' });
    if (!sessionLostNotified) {
      sessionLostNotified = true;
      options.onSessionLost?.(error);
    }
  };

  const forget = async () => {
    await storage.clear();
    emit(null);
  };

  const unsubscribeChannel = channel.subscribe((message) => {
    switch (message.type) {
      case 'tokens':
        void adopt(message.tokens);
        break;
      case 'cleared':
        void forget();
        break;
      case 'session-lost':
        void loseSession(new SessionLostError(), false);
        break;
    }
  });

  // One refresh at a time in this tab (shared promise) and, through the lock, across tabs.
  const refreshTokens = singleFlight(
    async (reason: RefreshReason, previous: T | null): Promise<T> =>
      lock.run(async () => {
        const current = await storage.get();
        if (
          isFresh(current) &&
          (previous === null || current.accessToken !== previous.accessToken)
        ) {
          // Another tab refreshed while we were waiting for the lock: reuse its token.
          emit(current);
          return current;
        }
        let tokens: T;
        try {
          tokens = await options.refresh({ previous: current, reason });
        } catch (error) {
          if (!isSessionLost(error)) throw error; // transient: keep the tokens, let the caller retry
          await loseSession(error, true);
          throw new SessionLostError(error);
        }
        if (!isTokenSet(tokens)) {
          throw new TypeError(
            'single-flight-auth: refresh() must resolve to { accessToken: string, expiresAt: number }',
          );
        }
        await adopt(tokens);
        channel.post({ type: 'tokens', tokens });
        return tokens;
      }),
  );

  const currentTokens = async (forceRefresh = false): Promise<T> => {
    assertUsable();
    const current = await storage.get();
    if (!forceRefresh && isFresh(current)) return current;
    const reason: RefreshReason = forceRefresh ? 'manual' : current ? 'expired' : 'missing';
    return refreshTokens(reason, current);
  };

  const client: AuthClient<T> = {
    async getAccessToken(opts) {
      return (await currentTokens(opts?.forceRefresh ?? false)).accessToken;
    },

    async getTokens() {
      assertUsable();
      return storage.get();
    },

    refresh() {
      return currentTokens(true);
    },

    async fetch(input, init) {
      const fetchImpl = options.fetch ?? globalThis.fetch;
      if (typeof fetchImpl !== 'function') {
        throw new Error('single-flight-auth: no fetch implementation available');
      }
      // Cloning per attempt lets a 401 retry resend the body, streams included.
      const template = new Request(input, init);
      const send = (accessToken: string) => {
        const request = template.clone();
        return fetchImpl(attachToken(request, accessToken) ?? request);
      };

      const tokens = await currentTokens();
      const response = await send(tokens.accessToken);
      if (response.status !== 401 || !retryOn401) return response;

      const renewed = await refreshTokens('unauthorized', tokens);
      return send(renewed.accessToken);
    },

    async setTokens(tokens) {
      assertUsable();
      if (!isTokenSet(tokens)) {
        throw new TypeError(
          'single-flight-auth: setTokens() expects { accessToken: string, expiresAt: number }',
        );
      }
      await adopt(tokens);
      channel.post({ type: 'tokens', tokens });
    },

    async clear() {
      assertUsable();
      await forget();
      channel.post({ type: 'cleared' });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeChannel();
      channel.close();
      listeners.clear();
    },
  };

  return client;
}

function sameTokens(a: TokenSet | null | undefined, b: TokenSet | null | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === null || b === null) return a === b;
  return a.accessToken === b.accessToken && a.expiresAt === b.expiresAt;
}

function defaultAttachToken(request: Request, accessToken: string): Request {
  request.headers.set('Authorization', `Bearer ${accessToken}`);
  return request;
}

function defaultIsSessionLost(error: unknown): boolean {
  const status = statusOf(error);
  return status === 401 || status === 403;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  const status = candidate.status ?? candidate.response?.status;
  return typeof status === 'number' ? status : undefined;
}
