# ADR 0002: The client lock does not replace a server-side grace period

Status: accepted · 2026-09-18

## Context

Serialising refreshes in the browser closes the common race, but not every way a rotated refresh
token can be presented twice:

- the holding tab is closed after the request reached the server but before the response arrived,
  so the new cookie was never stored;
- a proxy or middleware served a cached response carrying an old `Set-Cookie`;
- an in-flight request from before the refresh still carries the old token.

## Decision

The library documents (README, "Why the server needs a grace period too") that the refresh endpoint
should accept a just-consumed refresh token for a short window (10–60 s) and return the same
successor tokens, and treat reuse *after* the window as theft (revoke the token family). The
Playwright suite includes a row showing a 2 s grace period alone prevents logouts, at the price of
one refresh per tab.

## Consequences

- Belt and braces: the client makes refreshes rare and serial; the server makes the residual
  double-presentations harmless.
- The library never implements server logic; the mock server in `test/e2e` is a reference only.
