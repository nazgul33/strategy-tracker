import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { holdNext } from '../testing/holdFetch';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';
import { EDITED, entry, REJECTED } from '../testing/visionReview';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see
// PendingTable.test.tsx: a hoisted import binds to the real DOM and events
// silently break.
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

describe('VisionReviewPage while reloading', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    installFetchStub([
      { method: 'DELETE', url: '/api/vision-reviews/3', json: { ok: true } },
      { url: '/api/vision-reviews', json: { entries: [entry(3, [EDITED], 'AAPL'), entry(5, [REJECTED], 'SOXL')] } },
    ]);
    await act(async () => {
      root.render(d(VisionReviewPage));
    });
    await flush();
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

  const button = (text: string) => {
    const b = Array.from(container.querySelectorAll('button')).find((x) => x.textContent === text);
    if (!b) throw new Error(`button ${text} not found`);
    return b as HTMLButtonElement;
  };
  const click = async (text: string) => {
    await act(async () => {
      button(text).click();
    });
    await flush();
  };

  it('the Reload button shows its busy state while the list is read again', async () => {
    const held = holdNext('GET', '/api/vision-reviews');
    await click('Reload');

    expect(button('…').disabled).toBe(true);
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Reload')).toBe(false);

    held.release();
    await flush();
    expect(button('Reload').disabled).toBe(false);
  });

  it('a delete cannot start while a reload is in flight', async () => {
    await click('Delete');
    expect(button('Delete for real').disabled).toBe(false);

    const held = holdNext('GET', '/api/vision-reviews');
    await click('Reload');
    expect(button('Delete for real').disabled).toBe(true);

    held.release();
    await flush();
    expect(button('Delete for real').disabled).toBe(false);
  });
});
