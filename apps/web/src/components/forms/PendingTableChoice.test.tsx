import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';
import { installFetchStub, restoreFetch } from '../../testing/fetchStub';
import type { FetchCalls, Route } from '../../testing/fetchStub';
import { PENDING_SELL } from '../../testing/pendingRow';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() (see PendingTable.test.tsx).
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { PendingTable } = await import('./PendingTable');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe('PendingTable refused confirms', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let list: Route;

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

  async function render(row: PendingFillDto, refusal: string): Promise<FetchCalls> {
    list = { url: '/api/pending', json: [row] };
    const calls = installFetchStub([{ method: 'POST', url: '/api/pending', status: 422, json: { error: refusal } }, list]);
    await act(async () => {
      root.render(d(PendingTable, {}));
    });
    await flush();
    // A reload after the refusal would now empty the list.
    list.json = [];
    return calls;
  }

  const bucketSelect = () => container.querySelector('select[aria-label="Bucket"]') as HTMLSelectElement | null;
  const alertText = () => container.querySelector('[role=alert]')?.textContent;

  async function confirm() {
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Confirm')!;
    await act(async () => btn.click());
    await flush();
  }

  it('choose-bucket words the error and marks that row\'s bucket selector as required', async () => {
    const calls = await render(PENDING_SELL, 'choose-bucket');
    expect(bucketSelect()!.className).not.toContain('border-warning');
    await confirm();
    expect(calls.length).toBe(1);
    expect(alertText()).toBe('More than one bucket could have sold this — choose the bucket.');
    expect(container.querySelectorAll('tbody tr').length).toBe(2);
    expect(bucketSelect()!.className).toContain('border-warning');
    expect(container.querySelector('[data-needs-input]')!.textContent).toBe(
      'More than one bucket could have sold this. Choose the bucket.',
    );
  });

  it('choosing a bucket clears the required mark', async () => {
    await render(PENDING_SELL, 'choose-bucket');
    await confirm();
    const select = bucketSelect()!;
    await act(async () => {
      select.value = '3';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(bucketSelect()!.className).not.toContain('border-warning');
    expect(container.querySelector('[data-needs-input]')).toBeNull();
  });

  it('fill-date-in-future words the error and keeps the row', async () => {
    const calls = await render(PENDING_SELL, 'fill-date-in-future');
    await confirm();
    expect(calls.length).toBe(1);
    expect(alertText()).toBe('The trade date is after today (New York time).');
    expect(container.querySelectorAll('tbody tr').length).toBe(1);
    expect(bucketSelect()!.className).not.toContain('border-warning');
  });
});
