import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see PendingTable.test.tsx.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { PendingTable } = await import('./PendingTable');
const { autoFeeUsd } = await import('../../autofee');
const { costPercentText } = await import('../../format');
const { installFetchStub, restoreFetch } = await import('../../testing/fetchStub');
const { PENDING_ROW, setInputValue } = await import('../../testing/pendingRow');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// A host that owns the refresh key, as RunDetailPage does, plus a button to bump it.
function Host() {
  const [key, setKey] = React.useState(0);
  return d(
    'div',
    null,
    d('button', { type: 'button', 'data-testid': 'bump', onClick: () => setKey((k) => k + 1) }, 'bump'),
    d(PendingTable, { runId: 7, refreshKey: key }),
  );
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('PendingTable refreshKey', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let listGets = 0;
  let listRow: PendingFillDto = PENDING_ROW;

  beforeEach(async () => {
    listGets = 0;
    listRow = PENDING_ROW;
    installFetchStub([
      { method: 'POST', url: '/api/pending', json: { ok: true } },
      {
        url: '/api/pending',
        get json() {
          listGets += 1;
          return [listRow];
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

  const input = (label: string) => container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  const dialog = () => container.querySelector('[role=dialog]');

  async function mount() {
    await act(async () => root.render(d(Host)));
    await flush();
  }

  async function bump() {
    await act(async () => {
      (container.querySelector('[data-testid="bump"]') as HTMLButtonElement).click();
    });
    await flush();
  }

  async function press(text: string) {
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text);
    if (!btn) throw new Error(`button ${text} not found`);
    await act(async () => (btn as HTMLButtonElement).click());
    await flush();
  }

  it('the first render reads the list once', async () => {
    await mount();
    expect(listGets).toBe(1);
  });

  it('a new refreshKey re-reads the list and keeps a typed edit', async () => {
    await mount();
    await act(async () => setInputValue(input('Qty'), '11'));
    expect(listGets).toBe(1);

    await bump();

    expect(listGets).toBe(2);
    expect(input('Qty').value).toBe('11');
  });

  it('a refreshed costPpm reaches the default-fee popup', async () => {
    await mount();
    await act(async () => setInputValue(input('Fee'), ''));

    listRow = { ...PENDING_ROW, costPpm: 4000 };
    await bump();
    expect(listGets).toBe(2);

    await press('Confirm');

    const body = dialog()!.textContent!;
    const shares = input('Qty').value;
    const price = input('Price').value;
    expect(body).toContain(costPercentText(4000));
    expect(body).toContain(`$${autoFeeUsd(shares, price, 4000)}`);
    expect(body).not.toContain(`= $${autoFeeUsd(shares, price, 40)}`);
    expect(body).not.toContain(costPercentText(40));
  });
});
