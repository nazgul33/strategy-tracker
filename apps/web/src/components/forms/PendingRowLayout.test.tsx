import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see PendingTable.test.tsx.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { PendingTable } = await import('./PendingTable');
const { lookup } = await import('../../i18n/catalog');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ROW: PendingFillDto = {
  id: 9,
  runId: 7,
  captureId: 3,
  bucketIdx: null,
  side: 'buy',
  ticker: 'AAPL',
  shares: 10,
  price: '123450000',
  fee: 100,
  filledOn: '2026-11-10',
  status: 'pending',
  createdAt: '2026-11-10T14:30:00Z',
  hasImage: true,
  costPpm: 40,
  heldBuckets: [],
  mergeableBuckets: [],
  detected: { side: 'buy', shares: 10, price: '123450000', filledOn: '2026-11-10', fee: 100 },
};

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('pending row hints and phone-width layout', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
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

  async function render(row: PendingFillDto) {
    installFetchStub([{ url: '/api/pending', json: [row] }]);
    await act(async () => {
      root.render(d(PendingTable, { runId: 7 }));
    });
    await flush();
  }

  const field = (label: string) => container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  const type = (label: string, value: string) => act(async () => setInputValue(field(label), value));
  const confirmButton = () =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Confirm') as HTMLButtonElement;
  const bodyRows = () => [...container.querySelectorAll('tbody tr')];
  const MISSED_DATE: PendingFillDto = { ...ROW, filledOn: '', detected: { ...ROW.detected!, filledOn: null } };

  it('a hinted control is described by a hint that shows on focus', async () => {
    await render(ROW);
    await type('Qty', '11');
    const qty = field('Qty');
    const id = qty.getAttribute('aria-describedby')!;
    expect(id).toBe('pending-9-shares-hint');
    const hint = container.querySelector(`#${id}`)!;
    expect(hint.textContent).toBe('Changed from what vision read');
    expect(hint.hasAttribute('data-hint')).toBe(true);
    expect(qty.nextElementSibling).toBe(hint);
    expect(qty.className).toContain('peer');
    expect(qty.title).toBe('Changed from what vision read');
    for (const cls of ['sr-only', 'peer-focus:not-sr-only', 'peer-focus:block']) expect(hint.className).toContain(cls);
  });

  it('an untouched control has no description', async () => {
    await render(ROW);
    expect(field('Qty').hasAttribute('aria-describedby')).toBe(false);
    expect(container.querySelector('[data-hint]')).toBeNull();
  });

  it('a field vision missed is described once it is filled in', async () => {
    await render(MISSED_DATE);
    const date = container.querySelector('input[type=date]') as HTMLInputElement;
    expect(date.hasAttribute('aria-describedby')).toBe(false);
    await act(async () => setInputValue(date, '2026-11-11'));
    const hint = container.querySelector(`#${date.getAttribute('aria-describedby')}`)!;
    expect(hint.textContent).toBe('Filled in — vision read nothing here');
  });

  it('the derived fee is described by the auto hint', async () => {
    await render({ ...ROW, fee: null, detected: { ...ROW.detected!, fee: null } });
    const fee = field('Fee');
    const hint = container.querySelector(`#${fee.getAttribute('aria-describedby')}`)!;
    expect(hint.textContent).toBe(lookup('en', 'pendingFeeAutoHint'));
    expect(fee.hasAttribute('data-edit')).toBe(false);
    expect(fee.nextElementSibling).toBe(hint);
  });

  it('Confirm and Reject stack below sm and sit side by side from sm', async () => {
    await render(ROW);
    const wrapper = confirmButton().parentElement!;
    expect(wrapper.className).toContain('flex-col');
    expect(wrapper.className).toContain('sm:flex-row');
  });

  it('the needs-input message is in its own row under the field row, not in the pinned cell', async () => {
    await render(MISSED_DATE);
    const rows = bodyRows();
    expect(rows.length).toBe(2);
    const message = lookup('en', 'pendingNeedsOverride');
    expect(rows[1]!.hasAttribute('data-needs-input')).toBe(true);
    expect(rows[1]!.textContent).toBe(message);
    const pinned = rows[0]!.querySelectorAll('td');
    expect(pinned[pinned.length - 1]!.textContent).not.toContain(message);
    expect(confirmButton().getAttribute('aria-describedby')).toBe('pending-9-needs');
    expect(rows[1]!.querySelector('#pending-9-needs')!.className).toContain('sticky left-0');
  });

  it('the message row spans every header column', async () => {
    await render(MISSED_DATE);
    const headers = container.querySelectorAll('thead th').length;
    expect(headers).toBe(10);
    expect(bodyRows()[1]!.querySelector('td')!.getAttribute('colspan')).toBe(String(headers));
  });

  it('no message row when nothing is missing', async () => {
    await render(ROW);
    expect(bodyRows().length).toBe(1);
    expect(confirmButton().hasAttribute('aria-describedby')).toBe(false);
  });
});
