/**
 * Wraps an async function so that concurrent callers share the one in-flight promise.
 * The first caller's arguments win; later callers receive the same result or rejection.
 */
export function singleFlight<A extends unknown[], T>(
  fn: (...args: A) => Promise<T>,
): (...args: A) => Promise<T> {
  let inflight: Promise<T> | null = null;
  return (...args) => {
    if (inflight) return inflight;
    const flight = (async () => fn(...args))().finally(() => {
      inflight = null;
    });
    inflight = flight;
    return flight;
  };
}
