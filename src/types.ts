/** An access token and the absolute time (epoch milliseconds) at which it stops being valid. */
export interface TokenSet {
  accessToken: string;
  expiresAt: number;
}

/** Why a refresh was requested. */
export type RefreshReason = 'missing' | 'expired' | 'unauthorized' | 'manual';

export interface RefreshContext<T extends TokenSet = TokenSet> {
  /** The token set that was current when the refresh was requested, or `null` if there was none. */
  previous: T | null;
  reason: RefreshReason;
}

export type MaybePromise<T> = T | Promise<T>;

/**
 * Where the token set lives. Only the access token needs to be stored; keep the refresh token in an
 * httpOnly cookie whenever you can. Implementations may be synchronous or asynchronous.
 */
export interface TokenStorage<T extends TokenSet = TokenSet> {
  get(): MaybePromise<T | null>;
  set(tokens: T): MaybePromise<void>;
  clear(): MaybePromise<void>;
}

export type StorageOption<T extends TokenSet = TokenSet> =
  | 'memory'
  | 'localStorage'
  | 'sessionStorage'
  | TokenStorage<T>;

/** Serialises refreshes across tabs. `run` must hold the lock until `fn` settles. */
export interface RefreshLock {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * - `auto` (default): Web Locks when available, else a localStorage lease, else no lock.
 * - `web-locks`: `navigator.locks` only; throws at creation if unavailable.
 * - `lease`: cooperative localStorage lease with a TTL (best effort, for browsers without Web Locks).
 * - `none`: single-flight within this tab only.
 */
export type LockOption = 'auto' | 'web-locks' | 'lease' | 'none' | RefreshLock;

export type ChannelMessage<T extends TokenSet = TokenSet> =
  | { type: 'tokens'; tokens: T }
  | { type: 'cleared' }
  | { type: 'session-lost' }
  | { type: 'lease-released'; name: string };

/** Fans token changes out to other tabs. Defaults to a `BroadcastChannel`. */
export interface TokenChannel<T extends TokenSet = TokenSet> {
  post(message: ChannelMessage<T>): void;
  subscribe(listener: (message: ChannelMessage<T>) => void): () => void;
  close(): void;
}

export type ChannelOption<T extends TokenSet = TokenSet> = string | false | TokenChannel<T>;

export interface AuthClientOptions<T extends TokenSet = TokenSet> {
  /**
   * Obtains a new token set. Called at most once at a time per tab, and — with a cross-tab lock —
   * at most once at a time across tabs. Throw a `Response` (or anything `isSessionLost` recognises)
   * to signal that the session is gone; throw anything else for a transient failure.
   */
  refresh(context: RefreshContext<T>): Promise<T>;
  /** Default `'memory'`. Use `'localStorage'` to share the access token between tabs. */
  storage?: StorageOption<T>;
  /** Key used by the Web Storage adapters. Default `'single-flight-auth:tokens'`. */
  storageKey?: string;
  /** Default `'auto'`. */
  lock?: LockOption;
  /** Name of the Web Lock / lease. Default `'single-flight-auth:refresh'`. */
  lockName?: string;
  /** BroadcastChannel name, a custom channel, or `false` to disable cross-tab messaging. */
  channel?: ChannelOption<T>;
  /** Refresh proactively when the token expires within this window. Default 30 000 ms. */
  expirySkewMs?: number;
  /** How long a lease lock may be held before other tabs treat it as abandoned. Default 10 000 ms. */
  leaseTtlMs?: number;
  /** Classifies refresh errors. Default: a `Response` (or `{ status }`) with status 401 or 403. */
  isSessionLost?(error: unknown): boolean;
  /** Called once per lost session, in every tab. Typical use: redirect to the login page. */
  onSessionLost?(error: unknown): void;
  /** `fetch` implementation used by `client.fetch`. Default `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Attaches the access token to a request. Default: `Authorization: Bearer <token>`. */
  attachToken?(request: Request, accessToken: string): Request | undefined;
  /** Retry a request once after a 401 by refreshing first. Default `true`. */
  retryOn401?: boolean;
  /** Clock, injectable for tests. Default `Date.now`. */
  now?(): number;
}

export type TokensListener<T extends TokenSet = TokenSet> = (tokens: T | null) => void;

export interface AuthClient<T extends TokenSet = TokenSet> {
  /** Resolves a usable access token, refreshing first when it is missing or about to expire. */
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>;
  /** The stored token set, if any, without triggering a refresh. */
  getTokens(): Promise<T | null>;
  /** Forces a refresh (single-flight, cross-tab). */
  refresh(): Promise<T>;
  /** `fetch` with the access token attached; on 401 it refreshes once and retries once. */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Stores tokens obtained elsewhere (e.g. right after login) and tells other tabs. */
  setTokens(tokens: T): Promise<void>;
  /** Forgets the tokens in every tab. Does not call `onSessionLost`. */
  clear(): Promise<void>;
  /** Observes token changes from refreshes, `setTokens`, `clear` and other tabs. */
  subscribe(listener: TokensListener<T>): () => void;
  /** Releases the channel and listeners. The client is unusable afterwards. */
  dispose(): void;
}
