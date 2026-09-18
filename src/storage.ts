import type { StorageOption, TokenSet, TokenStorage } from './types';

export function isTokenSet(value: unknown): value is TokenSet {
  if (typeof value !== 'object' || value === null) return false;
  const { accessToken, expiresAt } = value as Record<string, unknown>;
  return (
    typeof accessToken === 'string' && typeof expiresAt === 'number' && Number.isFinite(expiresAt)
  );
}

/** Keeps the token set in a variable. Per tab; combine with a channel to stay in sync across tabs. */
export function memoryStorage<T extends TokenSet = TokenSet>(): TokenStorage<T> {
  let current: T | null = null;
  return {
    get: () => current,
    set: (tokens) => {
      current = tokens;
    },
    clear: () => {
      current = null;
    },
  };
}

/**
 * Keeps the token set in a Web Storage area under `key`. Reads go to the area so that tabs sharing
 * `localStorage` see each other's refreshes. When the area throws (quota, privacy modes) the adapter
 * falls back to an in-memory copy instead of failing the request.
 */
export function webStorage<T extends TokenSet = TokenSet>(
  area: Storage,
  key: string,
): TokenStorage<T> {
  let mirror: T | null = null;
  return {
    get() {
      try {
        const raw = area.getItem(key);
        if (raw === null) return null;
        const parsed: unknown = JSON.parse(raw);
        return isTokenSet(parsed) ? (parsed as T) : null;
      } catch {
        return mirror;
      }
    },
    set(tokens) {
      mirror = tokens;
      try {
        area.setItem(key, JSON.stringify(tokens));
      } catch {
        // Quota exceeded or storage disabled: the mirror keeps this tab working.
      }
    },
    clear() {
      mirror = null;
      try {
        area.removeItem(key);
      } catch {
        // Nothing to clean up if the area is unavailable.
      }
    },
  };
}

function getArea(name: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    const area = (globalThis as Record<string, unknown>)[name];
    if (!area || typeof (area as Storage).getItem !== 'function') return null;
    return area as Storage;
  } catch {
    // Accessing storage throws in sandboxed iframes and some privacy modes.
    return null;
  }
}

export function resolveStorage<T extends TokenSet>(
  option: StorageOption<T>,
  key: string,
): TokenStorage<T> {
  if (typeof option === 'object') return option;
  if (option === 'memory') return memoryStorage<T>();
  const area = getArea(option);
  return area ? webStorage<T>(area, key) : memoryStorage<T>();
}
