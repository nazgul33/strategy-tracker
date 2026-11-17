import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { VisionReviewEntryDto, VisionReviewFillDto } from '../api.types';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';

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

// Vision read the price as $123.45 and missed the fee; the operator corrected the price to
// $125.50 and left the fee alone, so the $1.00 booked is the one the system derived.
const EDITED: VisionReviewFillDto = {
  id: 11,
  outcome: 'confirmed',
  edited: true,
  feeOverridden: false,
  detected: { ...READ, fee: null },
  final: { ...READ, price: '1255000', fee: 100 },
};
const UNEDITED: VisionReviewFillDto = { id: 12, outcome: 'confirmed', edited: false, feeOverridden: false, detected: READ, final: READ };
const REJECTED: VisionReviewFillDto = { id: 13, outcome: 'rejected', edited: false, feeOverridden: false, detected: READ, final: null };
// The common case: vision read no fee, nothing was edited, the booked fee is the derived one.
const FEELESS: VisionReviewFillDto = {
  id: 14,
  outcome: 'confirmed',
  edited: false,
  feeOverridden: false,
  detected: { ...READ, fee: null },
  final: READ,
};
// Vision read no fee and the operator typed one.
const TYPED_FEE: VisionReviewFillDto = {
  id: 15,
  outcome: 'confirmed',
  edited: true,
  feeOverridden: true,
  detected: { ...READ, fee: null },
  final: { ...READ, fee: 250 },
};

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

describe('VisionReviewPage', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let entries: VisionReviewEntryDto[];
  let calls: ReturnType<typeof installFetchStub>;

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

  async function render(list: VisionReviewEntryDto[]) {
    entries = list;
    const listRoute = { url: '/api/vision-reviews', json: { entries } };
    calls = installFetchStub([
      { method: 'DELETE', url: '/api/vision-reviews/3', json: { ok: true } },
      listRoute,
    ]);
    // A reload after delete must see the server's new state.
    const stubbed = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/vision-reviews/3') && (init?.method ?? 'GET') === 'DELETE') {
        entries = entries.filter((e) => e.captureId !== 3);
        listRoute.json = { entries };
      }
      return stubbed(input, init);
    }) as typeof fetch;
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
  const rowOf = (card: Element, fillId: number, kind: 'detected' | 'final') =>
    card.querySelector(`[data-fill="${fillId}"][data-row="${kind}"]`) as HTMLElement;
  const cell = (row: HTMLElement, field: string) => row.querySelector(`[data-field="${field}"]`) as HTMLElement;

  it('lists one entry per kept screenshot with its image and fills', async () => {
    await render([entry(3, [EDITED, UNEDITED], 'AAPL'), entry(5, [REJECTED], 'SOXL')]);

    expect(container.textContent).toContain('Vision review');
    expect(cards().length).toBe(2);
    const first = cards()[0]!;
    expect(first.textContent).toContain('AAPL');
    expect(first.querySelector('[data-row=detected][data-fill="11"]')).toBeTruthy();
    expect(first.querySelector('[data-row=detected][data-fill="12"]')).toBeTruthy();
    expect(cards()[1]!.textContent).toContain('SOXL');

    const link = first.querySelector('a[href="/api/captures/3/image"]') as HTMLAnchorElement;
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noreferrer');
    expect(link.querySelector('img')!.getAttribute('src')).toBe('/api/captures/3/image');
  });

  it('marks the fields that differ and shows both detected and corrected values', async () => {
    await render([entry(3, [EDITED])]);
    const card = cards()[0]!;
    const detected = rowOf(card, 11, 'detected');
    const final = rowOf(card, 11, 'final');

    expect(cell(detected, 'price').textContent).toBe('$123.45');
    expect(cell(final, 'price').textContent).toBe('$125.50');
    expect(cell(detected, 'fee').textContent).toBe('—');
    expect(cell(final, 'fee').textContent).toBe('$1.00');

    expect(cell(detected, 'price').dataset.changed).toBe('true');
    expect(cell(final, 'price').dataset.changed).toBe('true');
    for (const field of ['side', 'shares', 'filledOn', 'fee']) {
      expect(cell(detected, field).dataset.changed).toBeUndefined();
      expect(cell(final, field).dataset.changed).toBeUndefined();
    }
    expect(cell(final, 'side').textContent).toBe('Buy');
    expect(cell(final, 'shares').textContent).toBe('10');
    expect(cell(final, 'filledOn').textContent).toBe('2026-11-10');
    expect(card.textContent).toContain('Edited');
  });

  it('does not mark the derived fee as a misread, even when another field was corrected', async () => {
    await render([entry(3, [EDITED])]);
    const card = cards()[0]!;
    expect(cell(rowOf(card, 11, 'detected'), 'fee').dataset.changed).toBeUndefined();
    expect(cell(rowOf(card, 11, 'final'), 'fee').dataset.changed).toBeUndefined();
    expect(rowOf(card, 11, 'final').querySelector('[data-auto-fee]')!.textContent).toBe('auto');
  });

  it('shows an unedited feeless capture as read, with the derived fee tagged auto and nothing highlighted', async () => {
    await render([entry(3, [FEELESS])]);
    const card = cards()[0]!;
    expect(card.querySelector('[data-changed]')).toBeNull();
    expect(card.textContent).toContain('As read');
    expect(card.textContent).not.toContain('Edited');
    expect(cell(rowOf(card, 14, 'detected'), 'fee').textContent).toBe('—');
    expect(cell(rowOf(card, 14, 'final'), 'fee').textContent).toBe('$1.00');
    expect(rowOf(card, 14, 'final').querySelector('[data-auto-fee]')).toBeTruthy();
    expect(rowOf(card, 14, 'detected').querySelector('[data-auto-fee]')).toBeNull();
  });

  it('marks a fee the operator typed as changed, and does not call it auto', async () => {
    await render([entry(3, [TYPED_FEE])]);
    const card = cards()[0]!;
    expect(cell(rowOf(card, 15, 'detected'), 'fee').dataset.changed).toBe('true');
    expect(cell(rowOf(card, 15, 'final'), 'fee').dataset.changed).toBe('true');
    expect(card.querySelector('[data-auto-fee]')).toBeNull();
  });

  it('keeps an unedited sibling fill unmarked', async () => {
    await render([entry(3, [UNEDITED])]);
    const card = cards()[0]!;
    expect(card.querySelector('[data-changed]')).toBeNull();
    expect(card.textContent).toContain('As read');
    expect(card.textContent).not.toContain('Edited');
  });

  it('shows an em dash for the finals of a rejected fill', async () => {
    await render([entry(3, [REJECTED])]);
    const card = cards()[0]!;
    const final = rowOf(card, 13, 'final');
    for (const field of ['side', 'shares', 'filledOn', 'price', 'fee']) {
      expect(cell(final, field).textContent).toBe('—');
    }
    expect(cell(rowOf(card, 13, 'detected'), 'price').textContent).toBe('$123.45');
    expect(card.querySelector('[data-changed]')).toBeNull();
    expect(card.textContent).toContain('Rejected');
  });

  it('renders the empty note when nothing is archived', async () => {
    await render([]);
    expect(cards().length).toBe(0);
    expect(container.textContent).toContain('No screenshots kept for review yet');
  });

  it('the first Delete click only arms the confirmation and calls nothing', async () => {
    await render([entry(3, [EDITED])]);

    await act(async () => {
      button('Delete', cards()[0]!).click();
    });
    await flush();

    expect(calls.length).toBe(0);
    expect(cards().length).toBe(1);
    expect(cards()[0]!.textContent).toContain('This cannot be undone');
    expect(button('Delete for real', cards()[0]!)).toBeTruthy();
  });

  it('Delete for real calls the endpoint and drops the entry', async () => {
    await render([entry(3, [EDITED], 'AAPL'), entry(5, [REJECTED], 'SOXL')]);

    await act(async () => {
      button('Delete', cards()[0]!).click();
    });
    await act(async () => {
      button('Delete for real', cards()[0]!).click();
    });
    await flush();

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['DELETE /api/vision-reviews/3']);
    expect(cards().length).toBe(1);
    expect(cards()[0]!.textContent).toContain('SOXL');
  });

  it('Cancel backs out: the entry stays, un-armed, and nothing is deleted', async () => {
    await render([entry(3, [EDITED])]);

    await act(async () => {
      button('Delete', cards()[0]!).click();
    });
    await act(async () => {
      button('Cancel', cards()[0]!).click();
    });
    await flush();

    expect(calls.length).toBe(0);
    expect(cards().length).toBe(1);
    expect(cards()[0]!.textContent).not.toContain('This cannot be undone');
    expect(Array.from(cards()[0]!.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Delete']);
  });

  it('shows the error and keeps the list when the delete fails', async () => {
    await render([entry(3, [EDITED])]);
    restoreFetch();
    installFetchStub([
      { method: 'DELETE', url: '/api/vision-reviews/3', status: 500, json: { error: 'boom' } },
      { url: '/api/vision-reviews', json: { entries: [entry(3, [EDITED])] } },
    ]);

    await act(async () => {
      button('Delete', cards()[0]!).click();
    });
    await act(async () => {
      button('Delete for real', cards()[0]!).click();
    });
    await flush();

    expect(cards().length).toBe(1);
    expect(container.querySelector('[role=alert]')).toBeTruthy();
  });
});
