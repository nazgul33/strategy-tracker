import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';
import { setInputValue } from '../../testing/dom';
import { PENDING_ROW, PENDING_SELL } from '../../testing/pendingRow';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() (see PendingTable.test.tsx).
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { PendingRow, initialRowValues } = await import('./PendingRow');
const { patchRowValues } = await import('../../pendingvalues');
const { LangProvider } = await import('../../i18n');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NEEDS_BUCKET = 'The tracker cannot tell which bucket sold this. Choose the bucket.';
const DATE_AFTER_TODAY = 'This date is after today (New York time). Change it before confirming.';
const NEEDS_TICKER = 'Vision could not read the ticker — reject this row and re-capture.';

function Harness({ row, bucketRefused }: { row: PendingFillDto; bucketRefused: boolean }) {
  const [values, setValues] = React.useState(() => initialRowValues(row));
  const [bucket, setBucket] = React.useState('');
  return d(PendingRow, {
    row,
    values,
    onChange: (patch) => setValues((prev) => patchRowValues(row, prev, patch)),
    bucket,
    onBucketChange: setBucket,
    bucketRefused,
    onOpenSideBySide: () => {},
    onConfirm: () => {},
    onReject: () => {},
    busy: false,
  });
}

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe('PendingRow order and standing choices', () => {
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
  });

  async function render(row: PendingFillDto, bucketRefused = false) {
    await act(async () => {
      root.render(
        d(LangProvider, null, d('table', null, d('tbody', null, d(Harness, { row, bucketRefused })))),
      );
    });
  }

  const bucketSelect = () => container.querySelector('select[aria-label="Bucket"]') as HTMLSelectElement | null;
  const dateInput = () => container.querySelector('input[aria-label="Trade date"]') as HTMLInputElement;
  const needsRow = () => container.querySelector('[data-needs-input]');
  const needsLines = () =>
    Array.from(container.querySelectorAll('[data-needs-input] [data-needs-line]')).map((el) => el.textContent);
  const describedBy = (el: Element) => container.querySelector(`#${el.getAttribute('aria-describedby')}`);

  async function choose(el: HTMLSelectElement, value: string) {
    await act(async () => {
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('the order line shows what the screen said', async () => {
    await render(PENDING_SELL);
    const sideCell = (container.querySelector('select[aria-label="Side"]') as HTMLElement).closest('td')!;
    const line = sideCell.querySelector('[data-order-line]')!;
    expect(line.textContent).toContain('매도/STOP(시장가)');
    expect(line.textContent).toContain('ordered 1 @ 0.00');
    expect(container.querySelectorAll('tbody tr:first-child td').length).toBe(10);
  });

  it('the order line shows a limit price with its cents and — for what was not read', async () => {
    const detected = { ...PENDING_SELL.detected!, orderType: null, orderPrice: '640700', orderedShares: null };
    await render({ ...PENDING_SELL, detected });
    expect(container.querySelector('[data-order-line]')!.textContent).toBe('ordered — @ 64.07');
  });

  it('a row without order data has no order line', async () => {
    await render(PENDING_ROW);
    expect(container.querySelector('[data-order-line]')).toBeNull();
    await render({ ...PENDING_ROW, detected: null });
    expect(container.querySelector('[data-order-line]')).toBeNull();
  });

  it('a row that needs a bucket marks the selector', async () => {
    await render({ ...PENDING_SELL, needsBucket: true });
    const select = bucketSelect()!;
    expect(select.className).toContain('border-warning');
    expect(needsLines()).toEqual([NEEDS_BUCKET]);
    expect(describedBy(select)!.textContent).toBe(NEEDS_BUCKET);

    await choose(select, '3');
    expect(bucketSelect()!.className).not.toContain('border-warning');
    expect(bucketSelect()!.getAttribute('aria-describedby')).toBeNull();
    expect(needsRow()).toBeNull();
  });

  it('a refused confirm marks the selector though the list said no choice was needed', async () => {
    await render({ ...PENDING_SELL, needsBucket: false }, true);
    expect(bucketSelect()!.className).toContain('border-warning');
    expect(needsLines()).toEqual([NEEDS_BUCKET]);
  });

  it('a row that needs no bucket is not marked', async () => {
    await render(PENDING_SELL);
    expect(bucketSelect()!.className).not.toContain('border-warning');
    expect(bucketSelect()!.getAttribute('aria-describedby')).toBeNull();
    expect(needsRow()).toBeNull();
  });

  it('a date after today is a standing issue', async () => {
    await render({ ...PENDING_ROW, today: '2026-11-12', filledOn: '2026-11-13', detected: { ...PENDING_ROW.detected!, filledOn: '2026-11-13' } });
    expect(dateInput().className).toContain('border-warning');
    expect(needsLines()).toEqual([DATE_AFTER_TODAY]);

    await act(async () => setInputValue(dateInput(), '2026-11-12'));
    expect(dateInput().className).not.toContain('border-warning');
    expect(needsRow()).toBeNull();
  });

  it('a date after today does not stand without the server date', async () => {
    await render({ ...PENDING_ROW, filledOn: '2099-01-01', detected: { ...PENDING_ROW.detected!, filledOn: '2099-01-01' } });
    expect(dateInput().className).not.toContain('border-warning');
    expect(needsRow()).toBeNull();
  });

  it('several issues show one line each', async () => {
    await render({
      ...PENDING_SELL,
      ticker: '',
      needsBucket: true,
      today: '2026-11-12',
      filledOn: '2026-11-13',
      detected: { ...PENDING_SELL.detected!, filledOn: '2026-11-13' },
    });
    expect(needsLines()).toEqual([NEEDS_TICKER, DATE_AFTER_TODAY, NEEDS_BUCKET]);
    const confirm = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Confirm')!;
    expect(describedBy(confirm)).toBe(container.querySelector('[data-needs-input] div'));
    expect(describedBy(bucketSelect()!)!.textContent).toBe(NEEDS_BUCKET);
  });
});
