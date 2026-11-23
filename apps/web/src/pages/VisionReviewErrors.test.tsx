import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { api } from '../api';
import type { VisionReviewEntryDto } from '../api.types';
import { lookup } from '../i18n/catalog';
import { installFetchStub, restoreFetch, type Route } from '../testing/fetchStub';
import { EDITED, entry, REJECTED, UNEDITED } from '../testing/visionReview';

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

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const en = (k: string, p?: Record<string, string | number>) => lookup('en', k, p);

describe('VisionReviewPage error handling', () => {
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
  const three = () => [...two(), entry(7, [UNEDITED], 'TQQQ')];
  const DELETE_OK = (id: number): Route => ({ method: 'DELETE', url: `/api/vision-reviews/${id}`, json: { ok: true } });
  const DELETE_500 = (id: number): Route => ({
    method: 'DELETE',
    url: `/api/vision-reviews/${id}`,
    status: 500,
    json: { error: 'boom' },
  });

  // A list route whose status and body can change mid-test, and which counts its GETs
  // (the stub records non-GET calls only).
  function listRoute(entries: VisionReviewEntryDto[]) {
    const state = { entries, status: 200, error: '', gets: 0 };
    const route: Route = {
      url: '/api/vision-reviews',
      get status() {
        return state.status;
      },
      get json() {
        state.gets += 1;
        return state.error ? { error: state.error } : { entries: state.entries };
      },
    };
    return { state, route };
  }

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
  const alerts = () => Array.from(container.querySelectorAll('[role=alert]'));
  const cardOf = (id: number) => container.querySelector(`[data-capture="${id}"]`)!;
  const dismissButton = () => container.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement | null;
  const click = async (text: string, card = 0) => {
    await act(async () => {
      button(text, cards()[card]!).click();
    });
    await flush();
  };
  const clickPage = async (text: string) => {
    await act(async () => {
      button(text).click();
    });
    await flush();
  };
  async function deleteCard(card: number) {
    await click('Delete', card);
    await click('Delete for real', card);
  }
  // Keeps the DELETE for `id` pending until the returned release is called.
  function holdDelete(id: number): () => Promise<void> {
    const inner = globalThis.fetch;
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes(`/api/vision-reviews/${id}`) && init?.method === 'DELETE'
        ? gate.then(() => inner(input, init))
        : inner(input, init)) as typeof fetch;
    return async () => {
      open();
      await flush();
    };
  }

  it('a failed delete stays in its card while another card is deleted', async () => {
    const { route } = listRoute(two());
    await render([DELETE_500(3), DELETE_OK(5), route]);
    await deleteCard(0);
    expect(alerts().length).toBe(1);
    expect(cardOf(3).contains(alerts()[0]!)).toBe(true);

    const release = holdDelete(5);
    await deleteCard(1);

    expect(alerts().length).toBe(1);
    expect(cardOf(3).contains(alerts()[0]!)).toBe(true);
    expect(alerts()[0]!.textContent).toBe(en('visionReviewErr.server', { code: 'boom' }));
    await release();
    expect(alerts().length).toBe(1);
    expect(cardOf(3).contains(alerts()[0]!)).toBe(true);
  });

  it('two failed deletes keep one error each, and a not-found on a third clears neither', async () => {
    const { state, route } = listRoute(three());
    await render([
      DELETE_500(3),
      DELETE_500(5),
      { method: 'DELETE', url: '/api/vision-reviews/7', status: 404, json: { error: 'not-found' } },
      route,
    ]);
    await deleteCard(0);
    await deleteCard(1);
    state.entries = two();
    await deleteCard(2);

    expect(cards().length).toBe(2);
    expect(cardOf(7)).toBeNull();
    const found = alerts();
    expect(found.length).toBe(2);
    expect(cardOf(3).contains(found[0]!)).toBe(true);
    expect(cardOf(5).contains(found[1]!)).toBe(true);
    expect(found.every((a) => a.textContent === en('visionReviewErr.server', { code: 'boom' }))).toBe(true);
  });

  it('not-found on delete reads as already deleted: no error, and the list reloads', async () => {
    const { state, route } = listRoute(two());
    await render([
      { method: 'DELETE', url: '/api/vision-reviews/3', status: 404, json: { error: 'not-found' } },
      route,
    ]);
    expect(state.gets).toBe(1);
    state.entries = [entry(5, [REJECTED], 'SOXL')];
    await deleteCard(0);

    expect(alerts().length).toBe(0);
    expect(cards().length).toBe(1);
    expect(cards()[0]!.getAttribute('data-capture')).toBe('5');
    expect(state.gets).toBe(2);
  });

  it('a page-level delete error can be dismissed', async () => {
    const { state, route } = listRoute(two());
    await render([DELETE_500(3), route]);
    state.entries = [entry(5, [REJECTED], 'SOXL')];
    await deleteCard(0);
    expect(alerts().length).toBe(1);
    expect(cards().some((c) => c.contains(alerts()[0]!))).toBe(false);

    await act(async () => {
      dismissButton()!.click();
    });

    expect(alerts().length).toBe(0);
    expect(dismissButton()).toBeNull();
  });

  it('a page-level list error can be dismissed and comes back on the next failed reload', async () => {
    const { state, route } = listRoute([]);
    state.status = 500;
    state.error = 'list-down';
    await render([route]);
    const worded = en('visionReviewErr.server', { code: 'list-down' });
    expect(alerts().map((a) => a.textContent)).toEqual([worded]);

    await act(async () => {
      dismissButton()!.click();
    });
    expect(alerts().length).toBe(0);

    await clickPage('Reload');
    expect(alerts().map((a) => a.textContent)).toEqual([worded]);
  });

  it('Reload re-reads the list and clears a list error once it succeeds', async () => {
    const { state, route } = listRoute(two());
    state.status = 500;
    state.error = 'list-down';
    await render([route]);
    expect(alerts().length).toBe(1);
    expect(cards().length).toBe(0);

    state.status = 200;
    state.error = '';
    await clickPage('Reload');

    expect(state.gets).toBe(2);
    expect(alerts().length).toBe(0);
    expect(cards().length).toBe(2);
  });

  it('Reload is disabled while a delete is in flight', async () => {
    const { route } = listRoute(two());
    await render([DELETE_OK(3), route]);
    expect(button('Reload').disabled).toBe(false);

    const release = holdDelete(3);
    await deleteCard(0);
    expect(button('Reload').disabled).toBe(true);

    await release();
    expect(button('Reload').disabled).toBe(false);
  });

  it('an unreachable server is worded', async () => {
    const { route } = listRoute(two());
    installFetchStub([route]);
    const inner = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/api/vision-reviews') && (init?.method ?? 'GET') === 'GET'
        ? Promise.reject(new TypeError('Failed to fetch'))
        : inner(input, init)) as typeof fetch;
    await act(async () => {
      root.render(d(VisionReviewPage));
    });
    await flush();

    expect(alerts().map((a) => a.textContent)).toEqual([en('errNetwork')]);
  });

  it('a list load that rejects with undefined still shows an error and no spinner', async () => {
    const spy = spyOn(api, 'listVisionReviews').mockRejectedValue(undefined);
    try {
      await act(async () => {
        root.render(d(VisionReviewPage));
      });
      await flush();

      expect(alerts().map((a) => a.textContent)).toEqual(['undefined']);
      expect(container.textContent).not.toContain('…');
    } finally {
      spy.mockRestore();
    }
  });
});
