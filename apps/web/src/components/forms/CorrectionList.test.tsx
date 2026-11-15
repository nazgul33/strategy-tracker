import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { CorrectionDto } from '../../api.types';
import { installFetchStub, restoreFetch, type Route } from '../../testing/fetchStub';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see
// PendingTable.test.tsx.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { CorrectionList } = await import('./CorrectionList');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ROW: CorrectionDto = {
  id: 1,
  runId: 7,
  fillId: 2,
  captureId: null,
  side: 'sell',
  ticker: 'SOXL',
  bookedShares: 44,
  bookedFilledOn: '2026-11-11',
  bookedPrice: '660300',
  bookedFee: 0,
  proposedPrice: '640700',
  proposedFee: 203,
  status: 'open',
  createdAt: '2026-11-15 00:00:00',
  stale: false,
};

let gets = 0;

function stub(rows: CorrectionDto[], extra: Route[] = []) {
  gets = 0;
  return installFetchStub([
    ...extra,
    {
      url: '/api/corrections',
      // Fires on every matched GET: doubles as the reload counter.
      get json() {
        gets += 1;
        return rows;
      },
    },
  ]);
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label) as
    | HTMLButtonElement
    | undefined;
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('CorrectionList', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  afterAll(() => {
    GlobalRegistrator.unregister();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(props: { runId?: number; onChanged?: () => void } = {}) {
    await act(async () => {
      root.render(d(CorrectionList, props));
    });
    await flush();
  }

  async function click(label: string) {
    await act(async () => {
      button(label)!.click();
    });
    await flush();
  }

  it('renders nothing when there are no corrections', async () => {
    stub([]);
    await render();
    expect(gets).toBe(1);
    expect(container.textContent).toBe('');
  });

  it('shows the load error instead of rendering nothing when GET fails', async () => {
    gets = 0;
    installFetchStub([
      {
        url: '/api/corrections',
        status: 500,
        get json() {
          gets += 1;
          return { error: 'boom-load' };
        },
      },
    ]);
    await render();
    expect(gets).toBe(1);
    expect(container.textContent).not.toBe('');
    expect(container.textContent).toContain('Corrections (from screenshots)');
    expect(container.textContent).toContain('boom-load');
  });

  it('shows booked → proposed price and fee change', async () => {
    stub([ROW]);
    await render();
    const text = container.querySelector('tbody tr')!.textContent!;
    expect(text).toContain('Fill #2');
    expect(text).toContain('SOXL');
    expect(text).toContain('$66.03');
    expect(text).toContain('$64.07');
    expect(text).toContain('$0.00 → $2.03');
    expect(container.textContent).toContain('Corrections (from screenshots)');
  });

  it('omits the fee arrow when the fee is unchanged or not proposed', async () => {
    stub([
      { ...ROW, id: 1, bookedFee: 203, proposedFee: 203 },
      { ...ROW, id: 2, bookedFee: 203, proposedFee: null },
    ]);
    await render();
    for (const tr of container.querySelectorAll('tbody tr')) {
      expect(tr.textContent).toContain('$2.03');
      expect(tr.textContent).not.toContain('$2.03 →');
    }
  });

  it('apply posts and reloads, calling onChanged', async () => {
    let changed = 0;
    const calls = stub([ROW], [{ method: 'POST', url: '/api/corrections/1/apply', json: { ok: true, deltaCents: 5 } }]);
    await render({ onChanged: () => (changed += 1) });
    expect(gets).toBe(1);

    await click('Apply');

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/corrections/1/apply']);
    expect(gets).toBe(2);
    expect(changed).toBe(1);
  });

  it('dismiss posts and reloads, calling onChanged', async () => {
    let changed = 0;
    const calls = stub([ROW], [{ method: 'POST', url: '/api/corrections/1/dismiss', json: { ok: true } }]);
    await render({ onChanged: () => (changed += 1) });

    await click('Dismiss');

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/corrections/1/dismiss']);
    expect(gets).toBe(2);
    expect(changed).toBe(1);
  });

  it('stale row hides Apply and shows the stale note', async () => {
    stub([{ ...ROW, stale: true }]);
    await render();
    expect(button('Apply')).toBeUndefined();
    expect(button('Dismiss')).toBeDefined();
    expect(container.textContent).toContain('This fill changed since the screenshot — dismiss this correction.');
  });

  it('409 correction-stale on apply shows the stale note and reloads', async () => {
    let changed = 0;
    stub([ROW], [{ method: 'POST', url: '/api/corrections/1/apply', status: 409, json: { error: 'correction-stale' } }]);
    await render({ onChanged: () => (changed += 1) });
    expect(container.textContent).not.toContain('dismiss this correction');

    await click('Apply');

    expect(container.textContent).toContain('This fill changed since the screenshot — dismiss this correction.');
    expect(gets).toBe(2);
    expect(changed).toBe(0);
  });

  it('409 correction-not-open on apply shows "Already handled" and reloads', async () => {
    let changed = 0;
    stub([ROW], [{ method: 'POST', url: '/api/corrections/1/apply', status: 409, json: { error: 'correction-not-open' } }]);
    await render({ onChanged: () => (changed += 1) });

    await click('Apply');

    expect(container.textContent).toContain('Already handled');
    expect(gets).toBe(2);
    expect(changed).toBe(1);
  });

  it('422 apply shows the localized fill error', async () => {
    stub([ROW], [{ method: 'POST', url: '/api/corrections/1/apply', status: 422, json: { error: 'invalid-fill' } }]);
    await render();

    await click('Apply');

    expect(container.textContent).toContain('Fill does not match this bucket — delete it and re-enter.');
  });

  it('unknown 422 code falls back to the raw code', async () => {
    stub([ROW], [{ method: 'POST', url: '/api/corrections/1/apply', status: 422, json: { error: 'weird-kind' } }]);
    await render();

    await click('Apply');

    expect(container.textContent).toContain('weird-kind');
  });

  it('apply with onChanged given loads the list exactly once more', async () => {
    stub([ROW], [{ method: 'POST', url: '/api/corrections/1/apply', json: { ok: true, deltaCents: 5 } }]);
    await render({ onChanged: () => {} });
    expect(gets).toBe(1);

    await click('Apply');

    expect(gets).toBe(2);
  });

  it("runId filter hides other runs' corrections", async () => {
    stub([ROW, { ...ROW, id: 2, runId: 8, fillId: 9, ticker: 'TQQQ' }]);
    await render({ runId: 7 });
    expect(container.textContent).toContain('SOXL');
    expect(container.textContent).not.toContain('TQQQ');
  });

  it('renders nothing when every correction belongs to another run', async () => {
    stub([{ ...ROW, runId: 8 }]);
    await render({ runId: 7 });
    expect(gets).toBe(1);
    expect(container.textContent).toBe('');
  });
});
