# single-flight-auth — notes for coding agents

Zero-dependency TypeScript library: single-flight access-token refresh within a tab (shared promise)
and across tabs (Web Locks, localStorage lease fallback), with a BroadcastChannel to keep tabs in sync.

## Commands
- `pnpm check` — lint (Biome), typecheck (both tsconfigs), unit tests (Vitest), build (tsdown), size-limit
- `pnpm e2e` — builds, then runs the Playwright race reproduction against `test/e2e/mock-server.ts`
- `pnpm changeset` — required for any change visible to users of the package

## Rules of the codebase
- No runtime dependencies. Browser globals (`navigator.locks`, `BroadcastChannel`, `localStorage`)
  are always guarded so the module imports cleanly in Node and SSR.
- Concurrency claims must be proven by a test that would fail without the mechanism
  (see `test/unit/client.test.ts` "the race, in one process" and `test/e2e/race.spec.ts`).
- The refresh token is never handled by this library; only the token set returned by `refresh()`.
- Keep the public surface in `src/index.ts` small; document every option in `src/types.ts`.
- Errors from user callbacks (`refresh`, listeners) must never leave the client in a broken state.

## Review checklist for PRs
- Does a test assert the behaviour, or only that code ran?
- Any change to `ChannelMessage` or storage format is a compatibility change between tabs running
  different versions: add a changeset and mention it in the README.
- Bundle size: `pnpm size` limit is 3 kB brotli per format.
