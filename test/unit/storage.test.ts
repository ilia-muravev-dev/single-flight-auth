import { describe, expect, it } from 'vitest';
import { isTokenSet, memoryStorage, webStorage } from '../../src';
import { resolveStorage } from '../../src/storage';
import { tokens } from './helpers';

function fakeArea(): Storage & { map: Map<string, string>; failing: boolean } {
  const area = {
    map: new Map<string, string>(),
    failing: false,
    get length() {
      return area.map.size;
    },
    key: (index: number) => [...area.map.keys()][index] ?? null,
    getItem(key: string) {
      if (area.failing) throw new Error('SecurityError');
      return area.map.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (area.failing) throw new Error('QuotaExceededError');
      area.map.set(key, value);
    },
    removeItem(key: string) {
      if (area.failing) throw new Error('SecurityError');
      area.map.delete(key);
    },
    clear() {
      area.map.clear();
    },
  };
  return area;
}

describe('isTokenSet', () => {
  it('accepts an object with a string accessToken and a finite expiresAt', () => {
    expect(isTokenSet({ accessToken: 'a', expiresAt: 1 })).toBe(true);
    expect(isTokenSet({ accessToken: 'a', expiresAt: 1, refreshToken: 'r' })).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isTokenSet(null)).toBe(false);
    expect(isTokenSet('token')).toBe(false);
    expect(isTokenSet({ accessToken: 1, expiresAt: 1 })).toBe(false);
    expect(isTokenSet({ accessToken: 'a', expiresAt: Number.NaN })).toBe(false);
    expect(isTokenSet({ accessToken: 'a' })).toBe(false);
  });
});

describe('memoryStorage', () => {
  it('round-trips and clears', () => {
    const storage = memoryStorage();
    expect(storage.get()).toBeNull();
    storage.set(tokens('a', 10));
    expect(storage.get()).toEqual(tokens('a', 10));
    storage.clear();
    expect(storage.get()).toBeNull();
  });
});

describe('webStorage', () => {
  it('serialises the whole token set under the key', () => {
    const area = fakeArea();
    const storage = webStorage(area, 'k');
    storage.set({ ...tokens('a', 10), refreshToken: 'r' } as never);
    expect(JSON.parse(area.map.get('k') ?? '')).toEqual({ ...tokens('a', 10), refreshToken: 'r' });
    expect(storage.get()).toEqual({ ...tokens('a', 10), refreshToken: 'r' });
    storage.clear();
    expect(area.map.has('k')).toBe(false);
    expect(storage.get()).toBeNull();
  });

  it('treats corrupt or foreign values as no token', () => {
    const area = fakeArea();
    const storage = webStorage(area, 'k');
    area.map.set('k', '{not json');
    expect(storage.get()).toBeNull();
    area.map.set('k', JSON.stringify({ something: 'else' }));
    expect(storage.get()).toBeNull();
  });

  it('falls back to an in-memory copy when the area throws', () => {
    const area = fakeArea();
    const storage = webStorage(area, 'k');
    area.failing = true;
    storage.set(tokens('a', 10));
    expect(area.map.size).toBe(0);
    expect(storage.get()).toEqual(tokens('a', 10));
    storage.clear();
    expect(storage.get()).toBeNull();
  });
});

describe('resolveStorage', () => {
  it('returns a custom storage object unchanged', () => {
    const custom = memoryStorage();
    expect(resolveStorage(custom, 'k')).toBe(custom);
  });

  it('falls back to memory when Web Storage is unavailable (Node)', () => {
    const storage = resolveStorage('localStorage', 'k');
    expect(storage.get()).toBeNull();
    storage.set(tokens('a', 10));
    expect(storage.get()).toEqual(tokens('a', 10));
  });
});
