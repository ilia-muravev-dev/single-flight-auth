# ADR 0003: The library never touches the refresh token

Status: accepted · 2026-09-18

## Context

The safest place for a refresh token in a browser is an httpOnly cookie, where scripts (including
injected ones) cannot read it. A library that stored refresh tokens in `localStorage` would make
the less safe setup the default.

## Decision

`createAuthClient` only knows the `refresh()` callback and the token set it resolves to
(`{ accessToken, expiresAt }`). How the refresh token reaches the server is the application's
business — normally `credentials: 'include'` on the refresh request.

Applications that must keep a refresh token in JavaScript can extend the token set type
(`createAuthClient<MyTokens>`) and read `context.previous` inside `refresh()`. The README states the
XSS trade-off next to that example.

## Consequences

- The library has no opinion on cookie names, token formats or endpoints.
- `storage: 'localStorage'` persists only what `refresh()` returned, which by default is an
  access token with a short lifetime.
