// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { RunDto } from '../api.types';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';
import { goOffline } from '../testing/offline';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { RunsListPage } = await import('./RunsList');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

// The list filters to `active` by default, so the fixture must be active to be listed.
const RUN: RunDto = {
  id: 1,
  strategyKey: 'mean-reversion',
  ticker: 'QQQ',
  name: 'Test run',
  poolCents: 100_000,
  costPpm: 700,
  buyGapPpm: 25_000,
  sellGapPpm: 10_000,
  cutLossPpm: 35_000,
  status: 'active',
  stateJson: '{}',
  createdAt: '2026-11-01T00:00:00Z',
};

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const notice = (id: number, text: string) => ({
  id,
  runId: null,
  ticker: null,
  text,
  sentAt: '2026-11-20T12:30:00.000Z',
  chatIds: ['web'],
});
const REMINDER = '16:05 fill capture reminder';
let noticeGets = 0;
let page: unknown = { entries: [notice(1, REMINDER)], nextBefore: null };
const trigger = {
  method: 'POST' as const,
  url: '/api/trigger/morning',
  status: 200,
  json: { result: '"conflict"' } as unknown,
};

const bulk = { method: 'POST' as const, url: '/api/runs/bulk-status', status: 200, json: { updated: 1 } as unknown };

describe('RunsListPage', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    noticeGets = 0;
    page = { entries: [notice(1, REMINDER)], nextBefore: null };
    trigger.status = 200;
    trigger.json = { result: '"conflict"' };
    bulk.status = 200;
    bulk.json = { updated: 1 };
    installFetchStub([
      trigger,
      bulk,
      {
        url: '/api/notifications',
        get json() {
          noticeGets += 1;
          return page;
        },
      },
      { url: '/api/runs', json: [RUN] },
    ]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(d(RunsListPage)));
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it("shows each run's cost as a percent", () => {
    expect(container.textContent).toContain('Test run');
    expect(container.textContent).toContain('0.070%');
  });

  const clickTrigger = async () => {
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Run morning pipeline');
    await act(async () => button!.click());
    await flush();
  };

  it('shows the System notices panel under the runs table', () => {
    expect(container.textContent).toContain('System notices');
    expect(container.textContent).toContain(REMINDER);
    expect(noticeGets).toBe(1);
  });

  it('reloads the notices after the morning trigger', async () => {
    page = { entries: [notice(2, 'Calendar conflict — check manually'), notice(1, REMINDER)], nextBefore: null };
    await clickTrigger();
    expect(noticeGets).toBe(2);
    expect(container.textContent).toContain('Calendar conflict — check manually');
  });

  it('a failed morning trigger shows the error and still reloads the notices', async () => {
    trigger.status = 500;
    trigger.json = { error: 'pipeline-error' };
    page = {
      entries: [notice(2, 'Morning pipeline error — the pipeline stopped before any run was planned. Check the server log, then run the morning pipeline again.')],
      nextBefore: null,
    };
    await clickTrigger();
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(
      'The morning pipeline stopped before planning any run. See System notices below.',
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(noticeGets).toBe(2);
    expect(container.textContent).toContain(
      'Morning pipeline error — the pipeline stopped before any run was planned.',
    );
  });

  const alertText = () => container.querySelector('[role="alert"]')?.textContent;
  const SERVER = (code: string) => `The server had a problem (${code}). Try again; if it keeps failing, check the server log.`;
  const NETWORK = 'Could not reach the server. Check the connection and try again.';

  it('a trigger that fails outside the pipeline does not blame the pipeline', async () => {
    trigger.status = 502;
    trigger.json = {};
    await clickTrigger();
    expect(alertText()).toBe(SERVER('http-502'));
  });

  it('a trigger with the server unreachable says so', async () => {
    goOffline('POST', '/api/trigger/morning');
    await clickTrigger();
    expect(alertText()).toBe(NETWORK);
  });

  it('a failed list reload is worded and can be retried', async () => {
    goOffline('GET', '/api/runs');
    await clickTrigger();
    expect(alertText()).toBe(NETWORK);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Retry')).toBe(true);
  });

  it('a failed bulk action is worded with its code', async () => {
    bulk.status = 500;
    bulk.json = {};
    await act(async () => (container.querySelector('input[aria-label="Test run"]') as HTMLInputElement).click());
    const pause = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Pause (1)');
    await act(async () => pause!.click());
    await flush();
    expect(alertText()).toBe(SERVER('http-500'));
  });
});
