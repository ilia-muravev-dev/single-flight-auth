import { mkdir, writeFile } from 'node:fs/promises';
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  test,
} from '@playwright/test';

declare global {
  interface Window {
    __ready: boolean;
    __events: string[];
    __login(): Promise<void>;
    __me(): Promise<number | string>;
  }
}

const TABS = 5;
const SERVER = { accessTtlMs: 400, refreshLatencyMs: 150 };

interface Stats {
  refreshAttempts: number;
  refreshOk: number;
  refreshRejected: number;
  apiOk: number;
  apiUnauthorized: number;
}

interface Row {
  scenario: string;
  refreshCalls: number;
  rejected: number;
  loggedOut: number;
  results: string;
}

const rows: Row[] = [];

async function openTabs(context: BrowserContext, query: string): Promise<Page[]> {
  const pages: Page[] = [];
  for (let i = 0; i < TABS; i += 1) {
    const page = await context.newPage();
    await page.goto(`/?${query}`);
    await page.waitForFunction(() => window.__ready);
    pages.push(page);
  }
  return pages;
}

/** Logs in once, lets the access token expire, then hits the API from every tab at the same moment. */
async function race(
  context: BrowserContext,
  request: APIRequestContext,
  scenario: string,
  query: string,
  graceMs = 0,
) {
  await request.post('/__reset', { data: { ...SERVER, graceMs } });
  const pages = await openTabs(context, query);
  const [first] = pages;
  if (!first) throw new Error('no tabs');

  await first.evaluate(() => window.__login());
  await first.waitForTimeout(SERVER.accessTtlMs + 100);

  const results = await Promise.all(pages.map((page) => page.evaluate(() => window.__me())));
  const stats = (await (await request.get('/__stats')).json()) as Stats;
  const lostPerTab = await Promise.all(
    pages.map((page) => page.evaluate(() => window.__events.length)),
  );
  const loggedOut = lostPerTab.reduce((sum, n) => sum + n, 0);

  rows.push({
    scenario,
    refreshCalls: stats.refreshAttempts,
    rejected: stats.refreshRejected,
    loggedOut,
    results: results.map(String).sort().join(', '),
  });
  return { results, stats, loggedOut };
}

test.describe('five tabs, one expired access token, refresh-token rotation on the server', () => {
  test('without the lock, four of five tabs are logged out (the bug)', async ({
    context,
    request,
  }) => {
    const { results, stats, loggedOut } = await race(
      context,
      request,
      'no lock, no channel',
      'lock=none&channel=off&storage=localStorage',
    );

    expect(stats.refreshAttempts).toBe(TABS);
    expect(stats.refreshOk).toBe(1);
    expect(stats.refreshRejected).toBe(TABS - 1);
    expect(results.filter((r) => r === 200)).toHaveLength(1);
    expect(results.filter((r) => r === 'session-lost')).toHaveLength(TABS - 1);
    expect(loggedOut).toBe(TABS - 1);
  });

  test('with Web Locks and localStorage, one refresh serves all five tabs', async ({
    context,
    request,
  }) => {
    const { results, stats, loggedOut } = await race(
      context,
      request,
      'Web Locks + localStorage',
      'lock=web-locks&storage=localStorage',
    );

    expect(stats.refreshAttempts).toBe(1);
    expect(stats.refreshRejected).toBe(0);
    expect(results).toEqual(Array(TABS).fill(200));
    expect(loggedOut).toBe(0);
  });

  test('the localStorage lease fallback behaves the same', async ({ context, request }) => {
    const { results, stats, loggedOut } = await race(
      context,
      request,
      'lease fallback + localStorage',
      'lock=lease&storage=localStorage',
    );

    expect(stats.refreshAttempts).toBe(1);
    expect(stats.refreshRejected).toBe(0);
    expect(results).toEqual(Array(TABS).fill(200));
    expect(loggedOut).toBe(0);
  });

  test('with Web Locks and per-tab memory storage, refreshes serialise and nobody is logged out', async ({
    context,
    request,
  }) => {
    const { results, stats, loggedOut } = await race(
      context,
      request,
      'Web Locks + memory storage + channel',
      'lock=web-locks&storage=memory',
    );

    expect(stats.refreshAttempts).toBeGreaterThanOrEqual(1);
    expect(stats.refreshAttempts).toBeLessThanOrEqual(TABS);
    expect(stats.refreshRejected).toBe(0);
    expect(results).toEqual(Array(TABS).fill(200));
    expect(loggedOut).toBe(0);
  });

  test('a server-side grace period alone also prevents logouts, at the price of five refreshes', async ({
    context,
    request,
  }) => {
    const { results, stats, loggedOut } = await race(
      context,
      request,
      'no lock, server grace period 2 s',
      'lock=none&channel=off&storage=localStorage',
      2_000,
    );

    expect(stats.refreshAttempts).toBe(TABS);
    expect(stats.refreshRejected).toBe(0);
    expect(results).toEqual(Array(TABS).fill(200));
    expect(loggedOut).toBe(0);
  });
});

test.afterAll(async () => {
  const header = '| Scenario | Refresh calls | Rejected by server | Tabs logged out | Results |';
  const divider = '| --- | ---: | ---: | ---: | --- |';
  const lines = rows.map(
    (r) => `| ${r.scenario} | ${r.refreshCalls} | ${r.rejected} | ${r.loggedOut} | ${r.results} |`,
  );
  const table = [header, divider, ...lines].join('\n');
  console.log(`\n${table}\n`);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/race-summary.md', `${table}\n`);
});
