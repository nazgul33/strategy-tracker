import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — a hoisted
// import binds to the real DOM and events silently break.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { SystemNotices } = await import('./SystemNotices');
const { LangProvider } = await import('../i18n');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PAGE1 = {
  nextBefore: 9,
  entries: [
    { id: 12, runId: 3, ticker: 'NVDA', text: 'Growth  NVDA\nTrade date: 2026-11-20\nBuy 2 @ $170.00', sentAt: '2026-11-20T12:30:00.000Z', chatIds: ['42', '43'] },
    { id: 10, runId: null, ticker: null, text: 'Calendar conflict — local and remote calendars disagree.\nNo orders today, please check manually', sentAt: '2026-11-20T12:30:00.000Z', chatIds: ['web', '42'] },
    { id: 9, runId: 8, ticker: null, text: '\n  orphan  \nsecond line', sentAt: '2026-11-19T12:30:00.000Z', chatIds: ['42'] },
  ],
};
const PAGE2 = {
  nextBefore: null,
  entries: [
    { id: 4, runId: null, ticker: null, text: '16:05 fill capture reminder', sentAt: '2026-11-18T21:05:00.000Z', chatIds: ['42'] },
  ],
};
// The cursor route comes first: the stub matches by substring in declaration order.
const older = { url: '/api/notifications?before=9', status: 200, json: PAGE2 as unknown };
const first = { url: '/api/notifications', status: 200, json: PAGE1 as unknown };

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

const cells = (n: number) => [...container.querySelectorAll(`tbody tr td:nth-child(${n})`)].map((el) => el.textContent ?? '');
const previews = () =>
  [...container.querySelectorAll('tbody tr td:nth-child(3) > a, tbody tr td:nth-child(3) > button')].map((el) => el.textContent ?? '');
const buttonByText = (text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;

beforeEach(() => {
  older.status = 200;
  older.json = PAGE2;
  first.status = 200;
  first.json = PAGE1;
  installFetchStub([older, first]);
  container = document.createElement('div');
  document.body.appendChild(container);
  localStorage.removeItem('st-lang');
});

afterEach(() => {
  if (root) act(() => root.unmount());
  container.remove();
  restoreFetch();
  localStorage.removeItem('st-lang');
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render() {
  root = createRoot(container);
  await act(async () => root.render(d(LangProvider, null, d(SystemNotices))));
  await flush();
}

async function click(el: Element | undefined | null) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

describe('SystemNotices', () => {
  it('lists run and system rows with a first-line preview', async () => {
    await render();
    expect(container.textContent).toContain('System notices');
    expect(cells(2)).toEqual(['#3 NVDA', 'System', '#8']);
    expect(previews()).toEqual([
      'Growth  NVDA',
      'Calendar conflict — local and remote calendars disagree.',
      'orphan',
    ]);
    expect(container.textContent).not.toContain('Buy 2 @');
  });

  it("a run row links to the run's Notifications tab with the notice id", async () => {
    await render();
    expect(container.querySelector('a[href="#/runs/3?tab=notifications&notice=12"]')!.textContent).toBe('Growth  NVDA');
    expect(container.querySelector('a[href="#/runs/8?tab=notifications&notice=9"]')).not.toBeNull();
  });

  it('a system row expands in place to its full text and chats, and collapses again', async () => {
    await render();
    const button = () => container.querySelector('tbody tr:nth-child(2) button') as HTMLButtonElement;
    await click(button());
    expect(button().getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('No orders today, please check manually');
    expect(container.textContent).toContain('Chat: web only, 42');
    expect(container.querySelectorAll('tbody tr').length).toBe(3);
    await click(button());
    expect(button().getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('No orders today, please check manually');
  });

  it('Show older appends the next page and then hides', async () => {
    await render();
    await click(buttonByText('Show older'));
    const items = previews();
    expect(items.length).toBe(4);
    expect(items[0]).toBe('Growth  NVDA');
    expect(items[3]).toBe('16:05 fill capture reminder');
    expect(buttonByText('Show older')).toBeUndefined();
  });

  it('no Show older button when the first page is the last', async () => {
    first.json = { ...PAGE1, nextBefore: null };
    await render();
    expect(buttonByText('Show older')).toBeUndefined();
  });

  it('an empty feed shows the empty note', async () => {
    first.json = { entries: [], nextBefore: null };
    await render();
    expect(container.textContent).toContain('No notifications.');
    expect(container.querySelector('tbody')).toBeNull();
  });

  it('a failed first load shows the error and Retry reloads it', async () => {
    first.status = 500;
    await render();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('tbody')).toBeNull();
    first.status = 200;
    await click(buttonByText('Retry'));
    expect(previews().length).toBe(3);
  });

  it('a failed Show older keeps the loaded rows and can be retried', async () => {
    await render();
    older.status = 500;
    await click(buttonByText('Show older'));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(previews().length).toBe(3);
    expect(buttonByText('Show older')).toBeDefined();
    older.status = 200;
    await click(buttonByText('Show older'));
    expect(previews().length).toBe(4);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('renders its chrome in Korean', async () => {
    localStorage.setItem('st-lang', 'ko');
    await render();
    expect(container.textContent).toContain('시스템 알림');
    expect(container.textContent).toContain('이전 알림 더 보기');
    expect(cells(2)[1]).toBe('시스템');
  });
});
