# ADR 0004: `memory` is the default storage; `localStorage` gives exactly-one refresh

Status: accepted · 2026-09-18

## Context

Inside the lock the client re-reads storage before refreshing: if another tab already stored a newer
token, no request is made. That check is only exact when tabs share the storage (`localStorage`).
With per-tab `memory` storage the newer token arrives through the `BroadcastChannel`, which usually
lands before the lock is granted but is not guaranteed to — so a second, serialised refresh can
happen. Serialised refreshes are safe with rotation; only concurrent ones are not.

## Decision

- Default to `memory`: nothing persisted, nothing readable from storage by injected scripts, and the
  behaviour is correct (no logouts) even if it costs an extra refresh now and then.
- Recommend `localStorage` when the application already keeps its access token there or wants the
  guaranteed single refresh (measured: 1 call for 5 tabs).

## Consequences

- The e2e table shows both modes so the trade-off is visible instead of implied.
- A page reload with `memory` storage always starts with a refresh (reason `missing`).
