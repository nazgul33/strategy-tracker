import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';

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
    expect(chatCells()).toEqual(['web only', '42']);
  });

  it('localizes the web-only label in Korean', async () => {
    localStorage.setItem('st-lang', 'ko');
    await render(d(NoticeList, { notifications: rows }));
    expect(chatCells()).toEqual(['웹 전용', '42']);
  });
});
