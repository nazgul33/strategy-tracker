import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { VisionReviewEntryDto, VisionReviewFillDto } from '../api.types';
import { installFetchStub, restoreFetch, type Route } from '../testing/fetchStub';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see
// PendingTable.test.tsx: a hoisted import binds to the real DOM and onChange
// silently breaks.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { VisionReviewPage } = await import('./VisionReview');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const READ = { side: 'buy', shares: 10, price: '1234500', filledOn: '2026-11-10', fee: 100 };

const EDITED: VisionReviewFillDto = {
  id: 11,
  outcome: 'confirmed',
  edited: true,
  feeOverridden: false,
  detected: { ...READ, fee: null },
  final: { ...READ, price: '1255000', fee: 100 },
};
const REJECTED: VisionReviewFillDto = { id: 13, outcome: 'rejected', edited: false, feeOverridden: false, detected: READ, final: null };

function entry(captureId: number, fills: VisionReviewFillDto[], ticker = 'AAPL'): VisionReviewEntryDto {
  return { captureId, runId: 7, ticker, createdAt: '2026-11-10 14:30:00', mime: 'image/png', byteLen: 20480, fills };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('VisionReviewPage delete errors', () => {
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

  const two = () => [entry(3, [EDITED], 'AAPL'), entry(5, [REJECTED], 'SOXL')];

  async function render(routes: Route[]) {
    installFetchStub(routes);
    await act(async () => {
      root.render(d(VisionReviewPage));
    });
    await flush();
  }

  const button = (text: string, within: ParentNode = container) => {
    const b = Array.from(within.querySelectorAll('button')).find((x) => x.textContent === text);
    if (!b) throw new Error(`button ${text} not found`);
    return b as HTMLButtonElement;
  };
  const cards = () => Array.from(container.querySelectorAll('[data-capture]'));
  const click = async (text: string) => {
    await act(async () => {
      button(text, cards()[0]!).click();
    });
    await flush();
  };
  const failedDelete = () =>
    render([
      { method: 'DELETE', url: '/api/vision-reviews/3', status: 500, json: { error: 'boom' } },
      { url: '/api/vision-reviews', json: { entries: two() } },
    ]);

  it('shows a failed delete inside the armed entry, not at page level', async () => {
    await failedDelete();
    await click('Delete');
    await click('Delete for real');

    const alerts = container.querySelectorAll('[role=alert]');
    expect(alerts.length).toBe(1);
    expect(cards()[0]!.contains(alerts[0]!)).toBe(true);
    expect(alerts[0]!.textContent).toBe('boom');
    expect(button('Delete for real', cards()[0]!)).toBeTruthy();
    expect(cards()[1]!.querySelector('[role=alert]')).toBeNull();
  });

  it('Cancel after a failed delete clears the error', async () => {
    await failedDelete();
    await click('Delete');
    await click('Delete for real');
    await click('Cancel');

    expect(container.querySelector('[role=alert]')).toBeNull();
    expect(Array.from(cards()[0]!.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Delete']);
  });

  it('a reload that fails after a delete shows next to that entry', async () => {
    const list: Route = { url: '/api/vision-reviews', json: { entries: two() } };
    await render([{ method: 'DELETE', url: '/api/vision-reviews/3', json: { ok: true } }, list]);
    list.status = 500;
    list.json = { error: 'list-down' };
    await click('Delete');
    await click('Delete for real');

    const alerts = container.querySelectorAll('[role=alert]');
    expect(alerts.length).toBe(1);
    expect(cards()[0]!.contains(alerts[0]!)).toBe(true);
    expect(alerts[0]!.textContent).toBe('list-down');
  });

  it('Cancel after a failed reload does not move the error to page level', async () => {
    const list: Route = { url: '/api/vision-reviews', json: { entries: two() } };
    await render([{ method: 'DELETE', url: '/api/vision-reviews/3', json: { ok: true } }, list]);
    list.status = 500;
    list.json = { error: 'list-down' };
    await click('Delete');
    await click('Delete for real');
    await click('Cancel');

    expect(container.querySelector('[role=alert]')).toBeNull();
  });
});
