/** Thrown when a refresh is rejected by the server and the stored tokens have been cleared. */
export class SessionLostError extends Error {
  override readonly name = 'SessionLostError';

  constructor(cause?: unknown) {
    super('Session lost: the refresh was rejected and the stored tokens were cleared', { cause });
  }
}
