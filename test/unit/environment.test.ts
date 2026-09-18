import { describe, expect, it } from 'vitest';
import { noLock } from '../../src';
import { noopChannel } from '../../src/broadcast';
import { hasWebLocks, resolveLock } from '../../src/cross-tab-lock';
import { sleep } from './helpers';

describe('in Node', () => {
  const config = { name: 'x', leaseTtlMs: 100, channel: noopChannel, now: Date.now };

  it('auto uses Web Locks when the runtime has them (Node 24+), otherwise no lock', async () => {
    const lock = resolveLock('auto', config);
    if (!hasWebLocks()) {
      expect(lock).toBe(noLock);
      return;
    }
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        lock.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await sleep(5);
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(1);
  });

  it('never picks the localStorage lease without localStorage', async () => {
    expect(typeof localStorage).toBe('undefined');
    await expect(resolveLock('auto', config).run(async () => 'ok')).resolves.toBe('ok');
  });
});
