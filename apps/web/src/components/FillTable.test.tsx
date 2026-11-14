import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — a hoisted
// import binds to the real DOM and events silently break.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { FillTable } = await import('./FillTable');
const { LangProvider } = await import('../i18n');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function fillDto(over: Partial<import('../api').FillDto> = {}): import('../api').FillDto {
  return {
    id: 1,
    runId: 7,
    ticker: 'QQQ',
    side: 'buy',
    bucketIdx: 2,
    shares: 10,
    price: '3402300',
    fee: 102,
    source: 'capture',
    filledOn: '2026-11-12',
    createdAt: '2026-11-12T15:30:00Z',
    ...over,
  };
}

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root.unmount());
  container.remove();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function render(node: React.ReactElement) {
  root = createRoot(container);
  return act(() => root.render(d(LangProvider, null, node)));
}

function texts(selector: string): string[] {
  return [...container.querySelectorAll(selector)].map((el) => el.textContent ?? '');
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

describe('FillTable', () => {
  it('renders the data columns without an actions column when onEdit is omitted', async () => {
    await render(d(FillTable, { fills: [fillDto()] }));
    const headers = texts('thead th');
    expect(headers).toEqual([
      'Side',
      'Qty',
      'Price',
      'Value',
      'Fee',
      'Filled',
      'Source',
      'Bucket',
    ]);
    expect(container.querySelector('[id^="fillEdit-"]')).toBeNull();
  });

  it('adds an Edit button per row when onEdit is provided', async () => {
    const edited: number[] = [];
    await render(
      d(FillTable, { fills: [fillDto({ id: 5 }), fillDto({ id: 6 })], onEdit: (f) => edited.push(f.id) }),
    );
    expect(texts('thead th').at(-1)).toBe('Actions');
    expect([...document.querySelectorAll('button[id^="fillEdit-"]')].map((b) => b.id)).toEqual([
      'fillEdit-5',
      'fillEdit-6',
    ]);

    await click(container.querySelector('#fillEdit-6')!);
    expect(edited).toEqual([6]);
  });

  it('renders a Delete button only on deletable rows and calls onDelete with that fill', async () => {
    const deleted: import('../api').FillDto[] = [];
    await render(
      d(FillTable, {
        fills: [fillDto({ id: 5 }), fillDto({ id: 6 })],
        onEdit: () => {},
        deletableIds: new Set([6]),
        onDelete: (f) => deleted.push(f),
      }),
    );
    const deleteButtons = [...container.querySelectorAll('button[id^="fillDelete-"]')];
    expect(deleteButtons.map((b) => b.id)).toEqual(['fillDelete-6']);
    expect(deleteButtons[0]!.textContent).toBe('Delete');

    await click(container.querySelector('#fillDelete-6')!);
    expect(deleted.length).toBe(1);
    expect(deleted[0]!.id).toBe(6);
  });

  it('renders no row delete buttons without deletableIds; Edit buttons unchanged', async () => {
    const edited: number[] = [];
    await render(
      d(FillTable, {
        fills: [fillDto({ id: 5 }), fillDto({ id: 6 })],
        onEdit: (f) => edited.push(f.id),
        onDelete: () => {},
      }),
    );
    expect(container.querySelectorAll('[id^="fillDelete-"]').length).toBe(0);
    expect([...container.querySelectorAll('button[id^="fillEdit-"]')].map((b) => b.id)).toEqual([
      'fillEdit-5',
      'fillEdit-6',
    ]);

    await click(container.querySelector('#fillEdit-5')!);
    expect(edited).toEqual([5]);
  });

  it('shows the empty note when there are no fills', async () => {
    await render(d(FillTable, { fills: [] }));
    expect(container.textContent).toContain('No fills.');
  });
});
