// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';
import type { FetchCalls, Route } from '../testing/fetchStub';
import { RUN_WITH_HISTORY, SUB_ROUTES, buttonByText, runDetailHelpers } from '../testing/runDetail';
import type { Post } from '../testing/runDetail';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { RunDetailPage } = await import('./RunDetail');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

let calls: FetchCalls;
let posts: Post[] = [];
let runGetCount = 0;

const { flush } = runDetailHelpers({
  act,
  calls: () => calls,
  onPosts: (mirrored) => (posts = mirrored),
});

// Route set with a switchable POST /api/runs/1/recalc endpoint. The helper
// re-reads status/json on every matched request, so mutating `flag` mid-test
// switches the endpoint between the 422 and 200 shapes.
function stubFetchWithRecalc(): { recalcFails: boolean; recalcCode: string; deltaCents: number; fillCount: number } {
  const flag = { recalcFails: true, recalcCode: 'no-run', deltaCents: 0, fillCount: 3 };
  runGetCount = 0;
  const routes: Route[] = [
    {
      method: 'POST',
      url: '/recalc',
      get status() {
        return flag.recalcFails ? 422 : 200;
      },
      get json() {
        return flag.recalcFails
          ? { error: flag.recalcCode }
          : { ok: true, deltaCents: flag.deltaCents, fillCount: flag.fillCount };
      },
    },
    { method: 'POST', url: '', json: { ok: true } },
    ...SUB_ROUTES,
    {
      url: '/api/runs/1',
      // Counted here because the helper records non-GET calls only:
      // one fire per GET of the run itself.
      get json() {
        runGetCount += 1;
        return RUN_WITH_HISTORY;
      },
    },
  ];
  calls = installFetchStub(routes);
  return flag;
}

const recalcPosts = () => posts.filter((p) => p.url.endsWith('/recalc'));

describe('RunDetailPage history recalc error handling', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let recalcFlag: { recalcFails: boolean; recalcCode: string };

  beforeEach(async () => {
    recalcFlag = stubFetchWithRecalc();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(d(RunDetailPage, { id: 1 })));
    await flush();
    await act(async () => {
      buttonByText('History').click();
    });
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('shows the localized recalc error and clears it on the next successful recalc', async () => {
    await act(async () => {
      buttonByText('Update').click();
    });
    await flush();
    expect(document.body.textContent).toContain('Run not found.');
    expect(recalcPosts().length).toBe(1);

    recalcFlag.recalcFails = false;
    await act(async () => {
      buttonByText('Update').click();
    });
    await flush();
    expect(document.body.textContent).not.toContain('Run not found.');
    expect(recalcPosts().length).toBe(2);
  });

  it('localizes known domain error codes instead of showing the raw code', async () => {
    recalcFlag.recalcCode = 'bucket-not-held';
    await act(async () => {
      buttonByText('Update').click();
    });
    await flush();
    expect(document.body.textContent).toContain('This bucket is not currently held.');
    expect(document.body.textContent).not.toContain('bucket-not-held');
  });

  it('an unknown recalc error keeps its code in worded copy', async () => {
    recalcFlag.recalcCode = 'zzz';
    await act(async () => {
      buttonByText('Update').click();
    });
    await flush();
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('The request failed (zzz).');
  });
});

describe('RunDetailPage recalc result popup', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let recalcFlag: { recalcFails: boolean; recalcCode: string; deltaCents: number; fillCount: number };

  beforeEach(async () => {
    recalcFlag = stubFetchWithRecalc();
    recalcFlag.recalcFails = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(d(RunDetailPage, { id: 1 })));
    await flush();
    await act(async () => {
      buttonByText('History').click();
    });
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  const popup = () => document.querySelector('[data-testid="recalcResult"]');
  // GETs of the run itself — one per useAsync reload().
  const runGets = () => runGetCount;

  it('shows the result popup after a successful recalc', async () => {
    await act(async () => {
      buttonByText('Update').click();
    });
    await flush();
    expect(popup()).not.toBeNull();
    expect(popup()!.textContent).toContain('Recalculation complete');
    expect(popup()!.textContent).toContain('No cash adjustment was needed.');
    expect(popup()!.textContent).toContain('Rebuilt run state from 3 fills.');
  });

  it('reports a booked cash adjustment in the popup', async () => {
    recalcFlag.deltaCents = -120;
    await act(async () => {
      buttonByText('Update').click();
    });
    await flush();
    expect(popup()).not.toBeNull();
    expect(popup()!.textContent).toContain('Cash was off by');
    expect(popup()!.textContent).toContain('-$1.20');
  });

  it('dismisses the popup on OK and refetches the run', async () => {
    await act(async () => {
      buttonByText('Update').click();
    });
    await flush();
    expect(popup()).not.toBeNull();
    const before = runGets();
    await act(async () => {
      buttonByText('OK').click();
    });
    await flush();
    expect(popup()).toBeNull();
    expect(runGets()).toBe(before + 1);
  });

  it('refetches the run when the popup is dismissed with the X button', async () => {
    await act(async () => {
      buttonByText('Update').click();
    });
    await flush();
    const before = runGets();
    await act(async () => {
      document
        .querySelector('[data-testid="recalcResult"] [role="dialog"] button[aria-label="Cancel"]')!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(popup()).toBeNull();
    expect(runGets()).toBe(before + 1);
  });

  it('refetches the run when the popup is dismissed by clicking the backdrop', async () => {
    await act(async () => {
      buttonByText('Update').click();
    });
    await flush();
    const before = runGets();
    await act(async () => {
      document
        .querySelector('[data-testid="recalcResult"] [role="dialog"]')!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(popup()).toBeNull();
    expect(runGets()).toBe(before + 1);
  });
});
