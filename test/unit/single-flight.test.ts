import { describe, expect, it } from 'vitest';
import { singleFlight } from '../../src';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe('singleFlight', () => {
  it('shares one in-flight promise between concurrent callers', async () => {
    let calls = 0;
    const flight = singleFlight(async (label: string) => {
      calls += 1;
      await tick();
      return `result for ${label}`;
    });

    const results = await Promise.all([flight('first'), flight('second'), flight('third')]);

    expect(calls).toBe(1);
    expect(results).toEqual(Array(3).fill('result for first'));
  });

  it('starts a new flight once the previous one has settled', async () => {
    let calls = 0;
    const flight = singleFlight(async () => {
      calls += 1;
      await tick();
      return calls;
    });

    expect(await flight()).toBe(1);
    expect(await flight()).toBe(2);
  });

  it('propagates a rejection to every caller and then resets', async () => {
    let calls = 0;
    const flight = singleFlight(async () => {
      calls += 1;
      await tick();
      if (calls === 1) throw new Error('boom');
      return 'ok';
    });

    const outcomes = await Promise.allSettled([flight(), flight()]);
    expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected']);
    expect(await flight()).toBe('ok');
  });

  it('turns a synchronous throw into a rejection', async () => {
    const flight = singleFlight((): Promise<never> => {
      throw new Error('sync');
    });
    await expect(flight()).rejects.toThrow('sync');
  });
});
