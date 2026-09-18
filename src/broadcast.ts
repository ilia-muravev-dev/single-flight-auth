import { isTokenSet } from './storage';
import type { ChannelMessage, ChannelOption, TokenChannel, TokenSet } from './types';

const MESSAGE_TYPES = new Set(['tokens', 'cleared', 'session-lost', 'lease-released']);

export function isChannelMessage<T extends TokenSet>(value: unknown): value is ChannelMessage<T> {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (typeof message.type !== 'string' || !MESSAGE_TYPES.has(message.type)) return false;
  if (message.type === 'tokens') return isTokenSet(message.tokens);
  if (message.type === 'lease-released') return typeof message.name === 'string';
  return true;
}

export const noopChannel: TokenChannel<never> = {
  post() {},
  subscribe() {
    return () => {};
  },
  close() {},
};

/** A `TokenChannel` backed by `BroadcastChannel`; a no-op where the API does not exist. */
export function broadcastChannel<T extends TokenSet>(name: string): TokenChannel<T> {
  if (typeof BroadcastChannel === 'undefined') return noopChannel;
  const channel = new BroadcastChannel(name);
  // Node keeps the event loop alive for open channels; a token cache must not do that.
  (channel as { unref?: () => void }).unref?.();
  const listeners = new Set<(message: ChannelMessage<T>) => void>();
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (!isChannelMessage<T>(event.data)) return;
    for (const listener of listeners) listener(event.data);
  };
  return {
    post(message) {
      try {
        channel.postMessage(message);
      } catch {
        // A closed channel or an unclonable payload must not break the refresh itself.
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      listeners.clear();
      channel.close();
    },
  };
}

export function resolveChannel<T extends TokenSet>(option: ChannelOption<T>): TokenChannel<T> {
  if (option === false) return noopChannel;
  if (typeof option === 'object') return option;
  return broadcastChannel<T>(option);
}
