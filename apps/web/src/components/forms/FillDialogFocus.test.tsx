// Where focus goes as FillDialog moves between its steps, opened — as in the
// app — from a focused page button (the fills table's Edit).
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see
// FillDialog.test.tsx.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { FillDialog } = await import('./FillDialog');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let deltaCents = 0;

function button(text: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!btn) throw new Error(`button [${text}] not found`);
  return btn;
}

// A short name for the focused element, so a failure reads as text, not a DOM dump.
function focused(): string {
  const el = document.activeElement;
  if (!el || el === document.body) return 'BODY';
  return el.textContent || el.getAttribute('aria-label') || el.tagName;
}

function closeX(): HTMLButtonElement {
  const btn = document.querySelector('[role="dialog"] button[aria-label="Cancel"]');
  if (!(btn instanceof HTMLButtonElement)) throw new Error('✕ not found');
  return btn;
}

// Focus first: happy-dom's click() does not move focus, a real activation does.
async function press(el: HTMLElement) {
  await act(async () => el.focus());
  await act(async () => el.click());
  await act(async () => {
    await Promise.resolve();
  });
}

function fillDto() {
  return {
    id: 3,
    runId: 7,
    bucketIdx: 1,
    side: 'sell' as const,
    ticker: 'AAPL',
    shares: 10,
    price: '3402300',
    fee: 102,
    filledOn: '2026-11-06',
    source: 'manual' as const,
    createdAt: '2026-11-06 10:00:00',
  };
}

// A page button opens the dialog, like RunPanels' Edit button.
function Host() {
  const [open, setOpen] = React.useState(false);
  return d(
    'div',
    null,
    d('button', { type: 'button', id: 'edit', onClick: () => setOpen(true) }, 'Edit'),
    open
      ? d(FillDialog, {
          runId: 7,
          costPpm: 30,
          fill: fillDto(),
          deletable: true,
          onClose: () => setOpen(false),
          onSaved: () => {},
        })
      : null,
  );
}

describe('FillDialog focus', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const editButton = () => document.getElementById('edit') as HTMLButtonElement;

  async function openFromEdit() {
    await act(async () => root.render(d(Host)));
    await press(editButton());
  }

  beforeEach(() => {
    deltaCents = 0;
    installFetchStub([
      { method: 'DELETE', url: '/api/runs/', json: { ok: true, deletedFillId: 3, deltaCents: 0 } },
      {
        method: 'PUT',
        url: '/api/runs/',
        get json() {
          return { ok: true, fill: { id: 3 }, deltaCents };
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

  afterAll(() => {
    GlobalRegistrator.unregister();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  it('the delete step opens with focus on Cancel, not the danger button', async () => {
    await openFromEdit();
    await press(button('Delete'));
    expect(focused()).toBe('Cancel');
    expect(document.activeElement).toBe(button('Cancel'));
  });

  it('returns focus to the page button after Delete, Cancel, then ✕', async () => {
    await openFromEdit();
    await press(button('Delete'));
    await press(button('Cancel'));
    expect(button('Delete')).toBeTruthy(); // back on the form step
    await press(closeX());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(focused()).toBe('Edit');
  });

  it('returns focus to the page button when the delete step is closed with ✕', async () => {
    await openFromEdit();
    await press(button('Delete'));
    await press(closeX());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(focused()).toBe('Edit');
  });

  it('returns focus to the page button after save, through the recalc result popup', async () => {
    deltaCents = -120;
    await openFromEdit();
    await press(button('Save'));
    expect(document.querySelector('[data-testid="recalc-result-modal"]')).not.toBeNull();
    await press(button('OK'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(focused()).toBe('Edit');
  });
});
