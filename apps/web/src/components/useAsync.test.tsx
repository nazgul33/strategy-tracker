// useAsync words its error through errorText for the current language and keeps the caught value.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — a hoisted
// import binds to the real DOM and events silently break.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { useAsync } = await import('./hooks');
const { ApiError, NetworkError } = await import('../api');
const { LangProvider, useLang } = await import('../i18n');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let next: () => Promise<string>;
let seenFailure: unknown;

function Probe() {
  const { data, error, failure, reload } = useAsync(() => next(), []);
  const { setLang } = useLang();
  seenFailure = failure;
  return d(
    'div',
    null,
    d('p', { id: 'data' }, data ?? ''),
    d('p', { id: 'error' }, error ?? ''),
    d('button', { id: 'reload', onClick: () => void reload() }, 'reload'),
    d('button', { id: 'ko', onClick: () => setLang('ko') }, 'ko'),
  );
}

describe('useAsync error text', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    localStorage.removeItem('st-lang');
    seenFailure = undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.removeItem('st-lang');
  });

  afterAll(() => {
    GlobalRegistrator.unregister();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  const text = (id: string) => document.getElementById(id)!.textContent;
  const settle = () =>
    act(async () => {
      await Promise.resolve();
    });
  const press = async (id: string) => {
    await act(async () => document.getElementById(id)!.click());
    await settle();
  };
  const render = async () => {
    await act(async () => root.render(d(LangProvider, null, d(Probe))));
    await settle();
  };

  it('an unreachable server is worded, and failure keeps the caught value', async () => {
    const caught = new NetworkError('Failed to fetch');
    next = () => Promise.reject(caught);
    await render();
    expect(text('error')).toBe('Could not reach the server. Check the connection and try again.');
    expect(seenFailure).toBe(caught);
  });

  it('a server failure keeps its code in worded copy', async () => {
    next = () => Promise.reject(new ApiError(500, 'http-500'));
    await render();
    expect(text('error')).toBe('The server had a problem (http-500). Try again; if it keeps failing, check the server log.');
  });

  it('a standing error follows a language switch', async () => {
    next = () => Promise.reject(new NetworkError('Failed to fetch'));
    await render();
    await press('ko');
    expect(text('error')).toBe('서버에 연결할 수 없습니다. 연결을 확인하고 다시 시도하세요.');
  });

  it('a rejection with no value still counts as an error, and a later success clears it', async () => {
    next = () => Promise.reject(undefined);
    await render();
    expect(text('error')).toBe('undefined');
    next = () => Promise.resolve('ok');
    await press('reload');
    expect(text('error')).toBe('');
    expect(text('data')).toBe('ok');
    expect(seenFailure).toBeUndefined();
  });
});
