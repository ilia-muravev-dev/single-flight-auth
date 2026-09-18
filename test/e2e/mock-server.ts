/**
 * A minimal auth server with refresh-token rotation, used by the Playwright suite and runnable on
 * its own for manual experiments:  node test/e2e/mock-server.ts --port 4173
 *
 *   POST /login          sets an httpOnly refresh cookie, returns a short-lived access token
 *   POST /auth/refresh   rotates the refresh token; a token presented twice is rejected with 401
 *                        unless the second use is within the configured grace period
 *   GET  /api/me         200 with a valid access token, 401 otherwise
 *   POST /__reset        { accessTtlMs, refreshLatencyMs, graceMs } — resets state and counters
 *   GET  /__stats        counters for assertions
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';

interface Config {
  accessTtlMs: number;
  refreshLatencyMs: number;
  graceMs: number;
}

interface RefreshToken {
  consumedAt: number | null;
  successor: { refreshToken: string; accessToken: string; expiresIn: number } | null;
}

const DEFAULT_CONFIG: Config = { accessTtlMs: 400, refreshLatencyMs: 150, graceMs: 0 };

let config: Config = { ...DEFAULT_CONFIG };
const refreshTokens = new Map<string, RefreshToken>();
const accessTokens = new Map<string, number>();
const stats = {
  refreshAttempts: 0,
  refreshOk: 0,
  refreshRejected: 0,
  apiOk: 0,
  apiUnauthorized: 0,
};

const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 4173);
const root = process.cwd();

function reset(next: Partial<Config>) {
  config = { ...DEFAULT_CONFIG, ...next };
  refreshTokens.clear();
  accessTokens.clear();
  for (const key of Object.keys(stats) as (keyof typeof stats)[]) stats[key] = 0;
}

function issueAccessToken() {
  const accessToken = `at-${randomUUID()}`;
  accessTokens.set(accessToken, Date.now() + config.accessTtlMs);
  return { accessToken, expiresIn: config.accessTtlMs };
}

function issueRefreshToken() {
  const id = `rt-${randomUUID()}`;
  refreshTokens.set(id, { consumedAt: null, successor: null });
  return id;
}

function cookies(request: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name) out[name] = rest.join('=');
  }
  return out;
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
    });
    request.on('end', () => resolve(data));
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  const method = request.method ?? 'GET';

  if (url.pathname === '/__health') return json(response, 200, { ok: true });
  if (url.pathname === '/__stats') return json(response, 200, { ...stats, config });
  if (url.pathname === '/__reset' && method === 'POST') {
    const body = await readBody(request);
    reset(body ? (JSON.parse(body) as Partial<Config>) : {});
    return json(response, 200, { ok: true, config });
  }

  if (url.pathname === '/login' && method === 'POST') {
    const refreshToken = issueRefreshToken();
    return json(response, 200, issueAccessToken(), {
      'set-cookie': `rt=${refreshToken}; HttpOnly; Path=/; SameSite=Lax`,
    });
  }

  if (url.pathname === '/auth/refresh' && method === 'POST') {
    stats.refreshAttempts += 1;
    const presented = cookies(request).rt;
    const record = presented ? refreshTokens.get(presented) : undefined;
    if (!record) {
      stats.refreshRejected += 1;
      return json(response, 401, { error: 'unknown refresh token' });
    }
    if (record.consumedAt !== null) {
      // Rotation: a refresh token is single-use. Within the grace period the same successor is
      // handed out again, which is what lets tabs that raced the winner survive.
      const withinGrace = Date.now() - record.consumedAt <= config.graceMs;
      if (!withinGrace || !record.successor) {
        stats.refreshRejected += 1;
        return json(response, 401, { error: 'refresh token already used' });
      }
      await sleep(config.refreshLatencyMs);
      stats.refreshOk += 1;
      const { accessToken, expiresIn } = record.successor;
      return json(response, 200, { accessToken, expiresIn });
    }
    // Consume atomically before doing any slow work, like a database transaction would.
    record.consumedAt = Date.now();
    const successor = { refreshToken: issueRefreshToken(), ...issueAccessToken() };
    record.successor = successor;
    await sleep(config.refreshLatencyMs);
    stats.refreshOk += 1;
    return json(
      response,
      200,
      { accessToken: successor.accessToken, expiresIn: successor.expiresIn },
      { 'set-cookie': `rt=${successor.refreshToken}; HttpOnly; Path=/; SameSite=Lax` },
    );
  }

  if (url.pathname === '/api/me') {
    const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
    const expiresAt = accessTokens.get(token);
    if (expiresAt === undefined || expiresAt <= Date.now()) {
      stats.apiUnauthorized += 1;
      return json(response, 401, { error: 'invalid or expired access token' });
    }
    stats.apiOk += 1;
    return json(response, 200, { ok: true });
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return response.end(await readFile(join(root, 'test/e2e/fixtures/app/index.html')));
  }
  if (url.pathname.startsWith('/dist/')) {
    try {
      const file = await readFile(join(root, url.pathname));
      response.writeHead(200, {
        'content-type': url.pathname.endsWith('.map') ? 'application/json' : 'text/javascript',
      });
      return response.end(file);
    } catch {
      return json(response, 404, { error: 'build the library first: pnpm build' });
    }
  }

  json(response, 404, { error: 'not found' });
}

createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    json(response, 500, { error: String(error) });
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`mock auth server listening on http://127.0.0.1:${port}`);
});
