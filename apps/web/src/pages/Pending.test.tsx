import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { CorrectionDto } from '../api.types';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see
// PendingTable.test.tsx.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { PendingPage } = await import('./Pending');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CORRECTION: CorrectionDto = {
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

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const headings = (tag: string) => Array.from(document.querySelectorAll(tag)).map((h) => h.textContent);

describe('PendingPage', () => {
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

  async function render(corrections: CorrectionDto[]) {
    installFetchStub([
      { url: '/api/corrections', json: corrections },
      { url: '/api/pending', json: [] },
    ]);
    await act(async () => {
      root.render(d(PendingPage));
    });
    await flush();
  }

  it('page title is Pending and Unconfirmed fills is a section heading', async () => {
    await render([]);
    expect(headings('h1')).toEqual(['Pending']);
    expect(headings('h2')).toContain('Unconfirmed fills');
    expect(container.textContent).not.toContain('Corrections (from screenshots)');
  });

  it('with corrections, both section headings render', async () => {
    await render([CORRECTION]);
    expect(headings('h1')).toEqual(['Pending']);
    expect(headings('h2')).toEqual(['Corrections (from screenshots)', 'Unconfirmed fills']);
  });
});
