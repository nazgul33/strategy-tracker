// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { inputByTestId } from '../testing/dom';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';
import type { FetchCalls } from '../testing/fetchStub';
import { goOffline } from '../testing/offline';
import { VR_DETAIL, VR_RUN } from '../testing/vr';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { VrRunPage } = await import('./VrRun');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

let detail: unknown = VR_DETAIL;
let detailGets = 0;
const patch = { method: 'PATCH' as const, url: '/api/vr/runs/5', status: 200, json: { ok: true } as unknown };

const withStatus = (status: 'active' | 'paused' | 'closed') => ({ ...VR_DETAIL, run: { ...VR_RUN, status } });

describe('VrRunPage status actions', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let calls: FetchCalls;

  const findButton = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text);
  const buttonByText = (text: string) => {
    const btn = findButton(text);
    if (!btn) throw new Error(`button [${text}] not found`);
    return btn;
  };
  const click = async (text: string) => {
    await act(async () => buttonByText(text).click());
    await flush();
  };
  const render = async () => {
    await act(async () => root.render(d(VrRunPage, { id: 5 })));
    await flush();
  };

  beforeEach(() => {
    detail = VR_DETAIL;
    detailGets = 0;
    patch.status = 200;
    patch.json = { ok: true };
    calls = installFetchStub([
      patch,
      { url: '/cycles', json: [] },
      { url: '/notifications', json: [] },
      { url: '/fills', json: [] },
      { url: '/cash', json: [] },
      {
        url: '/api/vr/runs/5',
        get json() {
          detailGets += 1;
          return detail;
        },
      },
    ]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });

  it('Pause sends the status and reloads the run', async () => {
    await render();
    const before = detailGets;
    await click('Pause');
    expect([...calls]).toEqual([{ method: 'PATCH', url: '/api/vr/runs/5', body: { status: 'paused' } }]);
    expect(detailGets).toBe(before + 1);
  });

  it('Resume sends active for a paused run', async () => {
    detail = withStatus('paused');
    await render();
    expect(findButton('Pause')).toBeUndefined();
    await click('Resume');
    expect([...calls]).toEqual([{ method: 'PATCH', url: '/api/vr/runs/5', body: { status: 'active' } }]);
  });

  it('Close asks first and sends closed only after Confirm', async () => {
    await render();
    await click('Close');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Close this run? No further buys.');
    expect(calls).toHaveLength(0);
    await click('Confirm');
    expect([...calls]).toEqual([{ method: 'PATCH', url: '/api/vr/runs/5', body: { status: 'closed' } }]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Cancel on the close question sends nothing', async () => {
    await render();
    await click('Close');
    await click('Cancel');
    expect(calls).toHaveLength(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('words a failed status change and keeps the page', async () => {
    patch.status = 409;
    patch.json = { error: 'invalid transition' };
    await render();
    await click('Pause');
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('The request failed (invalid transition).');
    expect(container.querySelector('h1')!.textContent).toContain('TQQQ lump sum');
  });

  it('words an unreachable server', async () => {
    await render();
    goOffline('PATCH', '/api/vr/runs/5');
    await click('Pause');
    expect(document.querySelector('[role="alert"]')!.textContent).toBe(
      'Could not reach the server. Check the connection and try again.',
    );
  });

  it('a closed run has no status buttons but keeps Settings', async () => {
    detail = withStatus('closed');
    await render();
    for (const text of ['Pause', 'Resume', 'Close']) expect(findButton(text)).toBeUndefined();
    expect(findButton('Settings')).toBeDefined();
    expect(container.querySelector('h1')!.textContent).toContain('Closed');
  });

  it('Settings opens the dialog prefilled from the run', async () => {
    await render();
    await click('Settings');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Run settings');
    expect(inputByTestId('vrGInput').value).toBe('10');
  });
});
