import { describe, expect, it } from 'vitest';
import { broadcastChannel } from '../../src';
import { isChannelMessage, noopChannel, resolveChannel } from '../../src/broadcast';
import { flush, tokens } from './helpers';

describe('isChannelMessage', () => {
  it('accepts the known message shapes', () => {
    expect(isChannelMessage({ type: 'tokens', tokens: tokens('a', 1) })).toBe(true);
    expect(isChannelMessage({ type: 'cleared' })).toBe(true);
    expect(isChannelMessage({ type: 'session-lost' })).toBe(true);
    expect(isChannelMessage({ type: 'lease-released', name: 'x' })).toBe(true);
  });

  it('rejects malformed messages', () => {
    expect(isChannelMessage(null)).toBe(false);
    expect(isChannelMessage({ type: 'tokens', tokens: { accessToken: 1 } })).toBe(false);
    expect(isChannelMessage({ type: 'lease-released' })).toBe(false);
    expect(isChannelMessage({ type: 'evil' })).toBe(false);
  });
});

describe('broadcastChannel', () => {
  it('delivers valid messages to other channels with the same name', async () => {
    const name = `test-${Math.random()}`;
    const a = broadcastChannel(name);
    const b = broadcastChannel(name);
    const received: unknown[] = [];
    b.subscribe((message) => received.push(message));

    a.post({ type: 'cleared' });
    a.post({ type: 'session-lost' });
    await flush();

    expect(received).toEqual([{ type: 'cleared' }, { type: 'session-lost' }]);
    a.close();
    b.close();
  });

  it('stops delivering after unsubscribe and close, and tolerates posting when closed', async () => {
    const name = `test-${Math.random()}`;
    const a = broadcastChannel(name);
    const b = broadcastChannel(name);
    const received: unknown[] = [];
    const unsubscribe = b.subscribe((message) => received.push(message));

    unsubscribe();
    a.post({ type: 'cleared' });
    await flush();
    expect(received).toEqual([]);

    a.close();
    expect(() => a.post({ type: 'cleared' })).not.toThrow();
    b.close();
  });
});

describe('resolveChannel', () => {
  it('maps false to the no-op channel and passes custom channels through', () => {
    expect(resolveChannel(false)).toBe(noopChannel);
    const custom = broadcastChannel('custom');
    expect(resolveChannel(custom)).toBe(custom);
    custom.close();
  });
});
