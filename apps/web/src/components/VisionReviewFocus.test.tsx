import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch, type Route } from '../testing/fetchStub';
import { holdNext } from '../testing/holdFetch';
import { EDITED, entry, REJECTED } from '../testing/visionReview';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see
// PendingTable.test.tsx: a hoisted import binds to the real DOM and events
// silently break.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { VisionReviewPage } = await import('../pages/VisionReview');

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

describe('VisionReviewPage focus', () => {
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

  async function render(routes: Route[]) {
    installFetchStub(routes);
    await act(async () => {
      root.render(d(VisionReviewPage));
    });
    await flush();
  }

  const cards = () => Array.from(container.querySelectorAll('[data-capture]'));
  const button = (text: string, card = 0) => {
    const b = Array.from(cards()[card]!.querySelectorAll('button')).find((x) => x.textContent === text);
    if (!b) throw new Error(`button ${text} not found`);
    return b as HTMLButtonElement;
  };
  const click = async (text: string, card = 0) => {
    await act(async () => {
      button(text, card).click();
    });
    await flush();
  };
  const active = () => document.activeElement as HTMLElement | null;
  const press = async (el: Element, key: string) => {
    const ev = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    await act(async () => {
      el.dispatchEvent(ev);
    });
    await flush();
    return ev;
  };
  const plain = () => render([{ url: '/api/vision-reviews', json: { entries: two() } }]);

  it('arming moves focus to Cancel', async () => {
    await plain();
    const del = button('Delete');
    act(() => del.focus());
    await click('Delete');

    expect(active()!.textContent).toBe('Cancel');
    expect(cards()[0]!.contains(active())).toBe(true);
  });

  it('Cancel returns focus to Delete', async () => {
    await plain();
    await click('Delete');
    act(() => button('Cancel').focus());
    await click('Cancel');

    expect(active()!.textContent).toBe('Delete');
    expect(cards()[0]!.contains(active())).toBe(true);
  });

  it('after a delete focus lands on the page heading', async () => {
    const list: Route = { url: '/api/vision-reviews', json: { entries: two() } };
    await render([DELETE_OK(3), list]);
    await click('Delete');
    act(() => button('Delete for real').focus());
    list.json = { entries: [entry(5, [REJECTED], 'SOXL')] };
    await click('Delete for real');

    expect(cards().length).toBe(1);
    expect(active()!.tagName).toBe('H1');
    expect(active()!.textContent).toBe('Vision review');
    expect(active()!.getAttribute('tabindex')).toBe('-1');
  });

  it('after the last card is deleted focus still lands on the page heading', async () => {
    const list: Route = { url: '/api/vision-reviews', json: { entries: [entry(3, [EDITED])] } };
    await render([DELETE_OK(3), list]);
    await click('Delete');
    act(() => button('Delete for real').focus());
    list.json = { entries: [] };
    await click('Delete for real');

    expect(cards().length).toBe(0);
    expect(active()!.tagName).toBe('H1');
  });

  it('does not steal focus that already sits on another control', async () => {
    const list: Route = { url: '/api/vision-reviews', json: { entries: two() } };
    await render([DELETE_OK(3), list]);
    await click('Delete');
    const reload = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Reload')!;
    act(() => reload.focus());
    list.json = { entries: [entry(5, [REJECTED], 'SOXL')] };
    await click('Delete for real');

    expect(cards().length).toBe(1);
    expect(active()).toBe(reload);
  });

  it('a failed delete keeps focus in its card and does not move it to the heading', async () => {
    await render([
      { method: 'DELETE', url: '/api/vision-reviews/3', status: 500, json: { error: 'boom' } },
      { url: '/api/vision-reviews', json: { entries: two() } },
    ]);
    await click('Delete');
    act(() => button('Delete for real').focus());
    await click('Delete for real');

    expect(active()!.tagName).not.toBe('H1');
    expect(cards()[0]!.contains(active())).toBe(true);
  });

  it('a failed delete does not pull focus to the heading even when focus fell to the body meanwhile', async () => {
    await render([
      { method: 'DELETE', url: '/api/vision-reviews/3', status: 500, json: { error: 'boom' } },
      { url: '/api/vision-reviews', json: { entries: two() } },
    ]);
    await click('Delete');
    act(() => button('Delete for real').focus());
    const held = holdNext('DELETE', '/api/vision-reviews/3');
    await click('Delete for real');
    // A disabled button ignores blur() in happy-dom: park focus on a throwaway node and drop it.
    act(() => {
      const spot = document.createElement('button');
      document.body.appendChild(spot);
      spot.focus();
      spot.remove();
    });
    expect(active()).toBe(document.body);

    held.release();
    await flush();

    expect(container.querySelector('[role=alert]')).toBeTruthy();
    expect(active()!.tagName).not.toBe('H1');
  });

  it('Escape while the delete is in flight leaves the panel armed', async () => {
    await render([
      { method: 'DELETE', url: '/api/vision-reviews/3', json: { ok: true } },
      { url: '/api/vision-reviews', json: { entries: two() } },
    ]);
    await click('Delete');
    const held = holdNext('DELETE', '/api/vision-reviews/3');
    await click('Delete for real');
    const ev = await press(cards()[0]!.querySelector('button[disabled]')!, 'Escape');

    expect(ev.defaultPrevented).toBe(false);
    expect(cards()[0]!.textContent).toContain('This cannot be undone');

    held.release();
    await flush();
  });

  it('dismissing a page-level error moves focus to the page heading', async () => {
    await render([{ url: '/api/vision-reviews', status: 500, json: { error: 'list-down' } }]);
    const dismiss = container.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement;
    act(() => dismiss.focus());
    expect(active()).toBe(dismiss);
    await act(async () => {
      dismiss.click();
    });
    await flush();

    expect(container.querySelector('[role=alert]')).toBeNull();
    expect(active()!.tagName).toBe('H1');
    expect(active()!.textContent).toBe('Vision review');
  });

  it('Escape on Cancel cancels the arm and returns focus to Delete', async () => {
    await plain();
    await click('Delete');
    const cancel = button('Cancel');
    act(() => cancel.focus());
    const ev = await press(cancel, 'Escape');

    expect(ev.defaultPrevented).toBe(true);
    expect(cards()[0]!.textContent).not.toContain('This cannot be undone');
    expect(active()!.textContent).toBe('Delete');
    expect(cards()[0]!.contains(active())).toBe(true);
  });

  it('Escape on "Delete for real" cancels the arm and returns focus to Delete', async () => {
    await plain();
    await click('Delete');
    const confirm = button('Delete for real');
    act(() => confirm.focus());
    await press(confirm, 'Escape');

    expect(cards()[0]!.textContent).not.toContain('This cannot be undone');
    expect(active()!.textContent).toBe('Delete');
    expect(cards()[0]!.contains(active())).toBe(true);
  });

  it('Escape clears a failed delete error just as Cancel does', async () => {
    await render([
      { method: 'DELETE', url: '/api/vision-reviews/3', status: 500, json: { error: 'boom' } },
      { url: '/api/vision-reviews', json: { entries: two() } },
    ]);
    await click('Delete');
    await click('Delete for real');
    expect(container.querySelector('[role=alert]')).toBeTruthy();
    await press(button('Delete for real'), 'Escape');

    expect(container.querySelector('[role=alert]')).toBeNull();
  });

  it('other keys do not cancel the arm', async () => {
    await plain();
    await click('Delete');
    await press(button('Cancel'), 'Enter');

    expect(cards()[0]!.textContent).toContain('This cannot be undone');
  });
});
