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

type NotificationDto = import('../api').NotificationDto;
const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** `n` notices with ids 1..n, each sent one minute after the previous; text is `msg <id>`. */
function makeRows(n: number): NotificationDto[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    runId: 7,
    chatId: '42',
    text: `msg ${i + 1}`,
    sentAt: new Date(Date.UTC(2026, 10, 10, 14, i)).toISOString(),
  }));
}

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  localStorage.removeItem('st-lang');
  installScrollShim();
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem('st-lang');
  restoreScrollShim();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

/** Renders (or re-renders into the same root, keeping component state). */
function render(props: { notifications: NotificationDto[]; highlightId?: number }) {
  return act(() => root.render(d(LangProvider, null, d(NoticeList, props))));
}

const texts = () => [...container.querySelectorAll('tbody tr td:nth-child(2)')].map((el) => el.textContent ?? '');
const status = () => container.querySelector('[data-testid="pager-status"]')?.textContent ?? null;
const pager = () => container.querySelector('nav[data-testid="pager"]');

function button(label: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!btn) throw new Error(`button ${label} not found`);
  return btn as HTMLButtonElement;
}

async function click(label: string) {
  await act(() => button(label).click());
}

async function pickSize(size: number) {
  const select = container.querySelector('select') as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
  await act(() => {
    setter.call(select, String(size));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('NoticeList ordering', () => {
  it('shows the newest notice first regardless of the order received', async () => {
    const rows = makeRows(3);
    await render({ notifications: [rows[1]!, rows[2]!, rows[0]!] });
    expect(texts()).toEqual(['msg 3', 'msg 2', 'msg 1']);
  });

  it('breaks a sentAt tie by the higher id first', async () => {
    const at = '2026-11-10T14:30:00.000Z';
    const rows = makeRows(3).map((r) => ({ ...r, sentAt: at }));
    await render({ notifications: rows });
    expect(texts()).toEqual(['msg 3', 'msg 2', 'msg 1']);
  });
});

describe('NoticeList paging', () => {
  it('hides the pager when everything fits on the smallest page', async () => {
    await render({ notifications: makeRows(5) });
    expect(texts()).toHaveLength(5);
    expect(pager()).toBeNull();
  });

  it('shows five per page by default and steps with previous/next', async () => {
    await render({ notifications: makeRows(12) });
    expect(texts()).toEqual(['msg 12', 'msg 11', 'msg 10', 'msg 9', 'msg 8']);
    expect(status()).toBe('Page 1 of 3');
    expect(button('Previous').disabled).toBe(true);
    await click('Next');
    expect(texts()).toEqual(['msg 7', 'msg 6', 'msg 5', 'msg 4', 'msg 3']);
    expect(status()).toBe('Page 2 of 3');
    await click('Next');
    expect(texts()).toEqual(['msg 2', 'msg 1']);
    expect(button('Next').disabled).toBe(true);
    await click('Previous');
    expect(status()).toBe('Page 2 of 3');
  });

  it('switches to 10 and 20 per page', async () => {
    await render({ notifications: makeRows(23) });
    await click('Next');
    await pickSize(10);
    expect(texts()).toHaveLength(10);
    expect(texts()[0]).toBe('msg 23');
    expect(status()).toBe('Page 1 of 3');
    await pickSize(20);
    expect(texts()).toHaveLength(20);
    expect(status()).toBe('Page 1 of 2');
  });

  it('clamps the page when the list shrinks', async () => {
    await render({ notifications: makeRows(12) });
    await click('Next');
    await click('Next');
    await render({ notifications: makeRows(7) });
    expect(status()).toBe('Page 2 of 2');
    expect(texts()).toEqual(['msg 2', 'msg 1']);
  });

  it('localizes the pager in Korean', async () => {
    localStorage.setItem('st-lang', 'ko');
    await render({ notifications: makeRows(12) });
    expect(status()).toBe('1 / 3 페이지');
    expect(button('다음')).toBeTruthy();
  });
});

describe('NoticeList paging with a highlighted notice', () => {
  const marked = () => [...container.querySelectorAll('tbody tr[aria-current="true"]')].map((el) => el.textContent ?? '');

  it('opens on the page holding the highlighted notice and scrolls to it', async () => {
    const spy = spyOn(window.Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    try {
      await render({ notifications: makeRows(12), highlightId: 3 });
      expect(status()).toBe('Page 2 of 3');
      expect(marked()[0]).toContain('msg 3');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('changing the page size returns to the highlighted notice page', async () => {
    await render({ notifications: makeRows(25), highlightId: 2 });
    expect(status()).toBe('Page 5 of 5');
    await click('Previous');
    await pickSize(10);
    expect(status()).toBe('Page 3 of 3');
    expect(marked()[0]).toContain('msg 2');
  });

  it('an unknown highlight id starts on page 1', async () => {
    await render({ notifications: makeRows(12), highlightId: 99 });
    expect(status()).toBe('Page 1 of 3');
    expect(marked()).toEqual([]);
  });

  it('a new highlight id while mounted jumps to its page', async () => {
    await render({ notifications: makeRows(12), highlightId: 12 });
    expect(status()).toBe('Page 1 of 3');
    await render({ notifications: makeRows(12), highlightId: 1 });
    expect(status()).toBe('Page 3 of 3');
    expect(marked()[0]).toContain('msg 1');
  });
});
