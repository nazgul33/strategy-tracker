import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { lookup } from '../i18n/catalog';
import { installFetchStub, restoreFetch, type FetchCalls, type Route } from '../testing/fetchStub';
import { EDITED, entry, REJECTED } from '../testing/visionReview';

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

describe('VisionReviewPage deletes', () => {
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
  const DELETE_OK = (id: number): Route => ({ method: 'DELETE', url: `/api/vision-reviews/${id}`, json: { ok: true } });

  async function render(routes: Route[]): Promise<FetchCalls> {
    const calls = installFetchStub(routes);
    await act(async () => {
      root.render(d(VisionReviewPage));
    });
    await flush();
    return calls;
  }

  const button = (text: string, within: ParentNode = container) => {
    const b = Array.from(within.querySelectorAll('button')).find((x) => x.textContent === text);
    if (!b) throw new Error(`button ${text} not found`);
    return b as HTMLButtonElement;
  };
  const cards = () => Array.from(container.querySelectorAll('[data-capture]'));
  const alerts = () => Array.from(container.querySelectorAll('[role=alert]'));
  const click = async (text: string, card = 0) => {
    await act(async () => {
      button(text, cards()[card]!).click();
    });
    await flush();
  };
  const failedDelete = () =>
    render([
      { method: 'DELETE', url: '/api/vision-reviews/3', status: 500, json: { error: 'boom' } },
      { url: '/api/vision-reviews', json: { entries: two() } },
    ]);
  // Delete 3 succeeds, then the list reload fails: `list-down` is shown for card 0.
  async function failedReload(extra: Route[] = []): Promise<void> {
    const list: Route = { url: '/api/vision-reviews', json: { entries: two() } };
    await render([DELETE_OK(3), ...extra, list]);
    list.status = 500;
    list.json = { error: 'list-down' };
    await click('Delete');
    await click('Delete for real');
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

  it('arming and deleting one card leaves its sibling untouched', async () => {
    const list: Route = { url: '/api/vision-reviews', json: { entries: two() } };
    const calls = await render([DELETE_OK(3), list]);

    await click('Delete');
    expect(Array.from(cards()[1]!.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Delete']);
    expect(cards()[1]!.textContent).not.toContain('This cannot be undone');

    list.json = { entries: [entry(5, [REJECTED], 'SOXL')] };
    await click('Delete for real');

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['DELETE /api/vision-reviews/3']);
    expect(cards().length).toBe(1);
    expect(cards()[0]!.getAttribute('data-capture')).toBe('5');
    expect(cards()[0]!.querySelector('[data-fill="13"]')).toBeTruthy();
    expect(Array.from(cards()[0]!.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Delete']);
  });

  it('shows a failed delete inside the armed entry, not at page level', async () => {
    await failedDelete();
    await click('Delete');
    await click('Delete for real');

    const found = alerts();
    expect(found.length).toBe(1);
    expect(cards()[0]!.contains(found[0]!)).toBe(true);
    expect(found[0]!.textContent).toBe(lookup('en', 'visionReviewErr.server', { code: 'boom' }));
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
    await failedReload();

    const found = alerts();
    expect(found.length).toBe(1);
    expect(cards()[0]!.contains(found[0]!)).toBe(true);
    expect(found[0]!.textContent).toBe(lookup('en', 'visionReviewErr.server', { code: 'list-down' }));
  });

  it("Cancel on another card leaves the failed card's error", async () => {
    await failedDelete();
    await click('Delete');
    await click('Delete for real');
    await click('Delete', 1);
    await click('Cancel', 1);

    const found = alerts();
    expect(found.length).toBe(1);
    expect(cards()[0]!.contains(found[0]!)).toBe(true);
    expect(found[0]!.textContent).toBe(lookup('en', 'visionReviewErr.server', { code: 'boom' }));
    expect(button('Delete for real', cards()[0]!)).toBeTruthy();
  });

  it('a list error from an earlier delete is not shown inside the next card while its delete is in flight', async () => {
    await failedReload([DELETE_OK(5)]);
    const release = holdDelete(5);
    await click('Delete', 1);
    await click('Delete for real', 1);

    expect(cards()[1]!.querySelector('[role=alert]')).toBeNull();
    const found = alerts();
    expect(found.length).toBe(1);
    expect(cards().some((c) => c.contains(found[0]!))).toBe(false);
    expect(found[0]!.textContent).toBe(lookup('en', 'visionReviewErr.server', { code: 'list-down' }));
    await release();
  });

  it('while a delete is in flight no other card can be deleted', async () => {
    await render([DELETE_OK(3), DELETE_OK(5), { url: '/api/vision-reviews', json: { entries: two() } }]);
    const release = holdDelete(3);
    await click('Delete', 0);
    await click('Delete', 1);
    await click('Delete for real', 0);

    expect(button('Delete for real', cards()[1]!).disabled).toBe(true);
    await release();
  });

  it('Cancel after a failed reload moves the list error to page level', async () => {
    await failedReload();
    await click('Cancel');

    const found = alerts();
    expect(found.length).toBe(1);
    expect(cards().some((c) => c.contains(found[0]!))).toBe(false);
    expect(found[0]!.textContent).toBe(lookup('en', 'visionReviewErr.server', { code: 'list-down' }));
    expect(Array.from(cards()[0]!.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Delete']);
  });

  it('a failed delete whose entry is gone from the reloaded list shows at page level', async () => {
    const list: Route = { url: '/api/vision-reviews', json: { entries: two() } };
    await render([{ method: 'DELETE', url: '/api/vision-reviews/3', status: 500, json: { error: 'boom' } }, list]);
    list.json = { entries: [entry(5, [REJECTED], 'SOXL')] };
    await click('Delete');
    await click('Delete for real');

    expect(cards().length).toBe(1);
    const found = alerts();
    expect(found.length).toBe(1);
    expect(cards().some((c) => c.contains(found[0]!))).toBe(false);
    expect(found[0]!.textContent).toBe(lookup('en', 'visionReviewErr.server', { code: 'boom' }));
  });
});
