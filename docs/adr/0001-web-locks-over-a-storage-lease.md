# ADR 0001: Web Locks first, a localStorage lease as fallback

Status: accepted · 2026-09-18

## Context

Two tabs that both notice an expired access token will both call the refresh endpoint. With
refresh-token rotation the second call presents a token the server has already consumed and is
rejected, so one tab is logged out. Mutual exclusion across tabs is needed. Candidates:

- **Web Locks API** (`navigator.locks.request`): exclusive, queued, and released by the browser when
  the holding tab closes or crashes. Chrome 69+, Firefox 96+, Safari 15.4+.
- **localStorage lease**: write `{ owner, expiresAt }`, wait a few milliseconds, check the value is
  still yours. Works everywhere but has no compare-and-swap, so it is only probabilistically
  exclusive, and a dead holder is only detected through the TTL.
- **SharedWorker / Service Worker** as the single refresher: exact, but a worker script must be
  hosted and registered, which is a deployment concern a library should not impose.

## Decision

`lock: 'auto'` uses Web Locks when present and the lease otherwise; `'none'` keeps in-tab
single-flight only. The lease is documented as best effort. No worker-based mode.

## Consequences

- On modern browsers the refresh is exactly single-flight across tabs (proven in `test/e2e`).
- On the lease path a crashed holder blocks other tabs for at most `leaseTtlMs` (10 s default).
- Node 24+ also exposes `navigator.locks`, so several clients in one process serialise too.
