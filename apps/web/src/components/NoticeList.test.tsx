import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { installScrollShim, restoreScrollShim } from '../testing/scrollShim';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — a hoisted
// import binds to the real DOM and events silently break.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { NoticeList } = await import('./NoticeList');
const { LangProvider } = await import('../i18n');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const rows: import('../api').NotificationDto[] = [
  { id: 1, runId: 7, chatId: 'web', text: 'cancel the other leg', sentAt: '2026-11-10T14:30:00.000Z' },
  { id: 2, runId: 7, chatId: '42', text: 'sold', sentAt: '2026-11-10T14:31:00.000Z' },
];

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  localStorage.removeItem('st-lang');
});

afterEach(() => {
  if (root) act(() => root.unmount());
  container.remove();
  localStorage.removeItem('st-lang');
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function render(node: React.ReactElement) {
  root = createRoot(container);
  return act(() => root.render(d(LangProvider, null, node)));
}

function chatCells(): string[] {
  return [...container.querySelectorAll('tbody tr td:nth-child(3)')].map((el) => el.textContent ?? '');
}

describe('NoticeList', () => {
  it('shows the web-only sentinel as a label and other chat ids as they are', async () => {
    await render(d(NoticeList, { notifications: rows }));
    expect(chatCells()).toEqual(['42', 'web only']);
  });

  it('localizes the web-only label in Korean', async () => {
    localStorage.setItem('st-lang', 'ko');
    await render(d(NoticeList, { notifications: rows }));
    expect(chatCells()).toEqual(['42', '웹 전용']);
  });
});

describe('NoticeList highlight', () => {
  const marked = () => [...container.querySelectorAll('tbody tr[aria-current="true"]')].map((el) => el.textContent ?? '');

  beforeEach(installScrollShim);
  afterEach(restoreScrollShim);

  it('marks the highlighted notice and scrolls it into view once', async () => {
    const spy = spyOn(window.Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    try {
      await render(d(NoticeList, { notifications: rows, highlightId: 2 }));
      const found = marked();
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('sold');
      expect(container.querySelector('tbody tr[aria-current="true"]')?.className).toContain('bg-primary/10');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ block: 'center' });
      await act(() => root.render(d(LangProvider, null, d(NoticeList, { notifications: rows, highlightId: 2 }))));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('an unknown highlight id marks nothing and does not scroll', async () => {
    const spy = spyOn(window.Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    try {
      await render(d(NoticeList, { notifications: rows, highlightId: 99 }));
      expect(marked()).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(0);
      expect(chatCells()).toEqual(['42', 'web only']);
    } finally {
      spy.mockRestore();
    }
  });

  it('without a highlight id no row is marked', async () => {
    const spy = spyOn(window.Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    try {
      await render(d(NoticeList, { notifications: rows }));
      expect(marked()).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      spy.mockRestore();
    }
  });
});
