// VR routes of the app shell. Kept apart from App.test.tsx, which is near the size limit.
// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from './testing/fetchStub';
import { VR_APP_ROUTES } from './testing/vr';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { App } = await import('./App');
const { setToken } = await import('./api');

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

describe('App VR routes', () => {
  let container: HTMLDivElement | undefined;
  let root: ReturnType<typeof createRoot> | undefined;

  async function open(hash: string) {
    window.location.hash = hash;
    setToken('test-token');
    container = document.createElement('div');
    document.body.appendChild(container);
    const mounted = createRoot(container);
    root = mounted;
    await act(async () => mounted.render(d(App)));
    await flush();
  }

  beforeEach(() => {
    root = undefined;
    container = undefined;
    installFetchStub(VR_APP_ROUTES);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    restoreFetch();
    setToken(null);
    window.location.hash = '';
  });

  it('#/vr lists the VR runs with the VR nav item active', async () => {
    await open('#/vr');
    expect(document.body.textContent).toContain('TQQQ lump sum');
    const nav = (href: string) => document.querySelector(`nav a[href="${href}"]`)!;
    expect(nav('#/vr').textContent).toBe('VR');
    expect(nav('#/vr').classList.contains('bg-muted')).toBe(true);
    expect(nav('#/runs').classList.contains('bg-muted')).toBe(false);
  });

  it('navigating from #/vr/1 to #/vr/2 remounts the page', async () => {
    await open('#/vr/1');
    const first = document.querySelector('[data-testid="vr-run-page"]')!;
    expect(first.getAttribute('data-run-id')).toBe('1');
    await act(async () => {
      window.location.hash = '#/vr/2';
      window.dispatchEvent(new window.Event('hashchange'));
    });
    await flush();
    const second = document.querySelector('[data-testid="vr-run-page"]')!;
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
    expect(second.getAttribute('data-run-id')).toBe('2');
  });

  it('a malformed VR route falls back to the not-found page', async () => {
    await open('#/vr/abc');
    expect(document.querySelector('[data-testid="vr-run-page"]')).toBeNull();
    expect(document.body.textContent).not.toContain('TQQQ lump sum');
  });
});
