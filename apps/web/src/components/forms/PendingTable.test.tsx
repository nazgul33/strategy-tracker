import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — same reason
// as in GapEditForm.test.tsx: a hoisted import binds to the real DOM and
// onChange silently breaks.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { PendingTable } = await import('./PendingTable');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface FetchCall {
  url: string;
  method: string;
}

const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];

// One valid, complete pending row (no override highlight) for the table.
const ROW: PendingFillDto = {
  id: 9,
  runId: 7,
  captureId: 3,
  bucketIdx: null,
  side: 'buy',
  ticker: 'AAPL',
  shares: 10,
  price: '123450000', // myriadths → $12,345
  fee: 100,
  filledOn: '2026-11-10',
  status: 'pending',
  createdAt: '2026-11-10T14:30:00Z',
};

// GET /api/pending always returns [ROW]; every POST (the confirm) replies
// 409 with the given server error code.
function stubFetch(confirmCode: string) {
  globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method });
    if (method === 'GET') {
      return new Response(JSON.stringify([ROW]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: confirmCode }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const pendingGets = () => calls.filter((c) => c.method === 'GET' && c.url === '/api/pending').length;

function confirmButton(): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Confirm');
  if (!btn) throw new Error('confirm button not found');
  return btn as HTMLButtonElement;
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderTable(root: ReturnType<typeof createRoot>) {
  await act(async () => {
    root.render(d(PendingTable, { runId: 7 }));
  });
  await flush();
}

async function clickConfirm() {
  await act(async () => {
    confirmButton().click();
  });
  await flush();
}

describe('PendingTable', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    calls = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
  });

  afterAll(() => {
    GlobalRegistrator.unregister();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows the ticker-mismatch message without reloading after a 409 confirm', async () => {
    stubFetch('ticker-mismatch');
    await renderTable(root);
    expect(container.textContent).toContain('AAPL');

    await clickConfirm();

    expect(container.textContent).toContain('Ticker does not match the run — reject this row and re-capture.');
    expect(container.textContent).not.toContain('Already handled');
    // Integrity guard: the row is untouched, so no reload — it must stay
    // visible (one GET = the initial load only) for the user to reject it.
    expect(pendingGets()).toBe(1);
    expect(container.textContent).toContain('AAPL');
  });

  it('still shows "Already handled" and reloads on a generic 409', async () => {
    stubFetch('pending-not-pending');
    await renderTable(root);
    expect(container.textContent).toContain('AAPL');

    await clickConfirm();

    expect(container.textContent).toContain('Already handled');
    expect(pendingGets()).toBe(2);
  });
});
