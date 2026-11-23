import type { act as ReactAct, createElement as ReactCreateElement } from 'react';
import type { Root } from 'react-dom/client';
import type { PendingTable as PendingTableComponent } from '../components/forms/PendingTable';
import type { PendingFillDto } from '../api.types';
import { installFetchStub } from './fetchStub';
import { PENDING_ROW as ROW } from './pendingRow';

// GET /api/pending always returns [row] (default ROW); every POST (the
// confirm) replies with the given status (default 409) and server error code.
// onGet fires on every matched GET, so a test file can use it as the reload
// counter the integrity-guard assertions read.
export function stubPendingFetch(confirmCode: string, row: PendingFillDto = ROW, status = 409, onGet?: () => void) {
  installFetchStub([
    { method: 'POST', url: '/api/pending', status, json: { error: confirmCode } },
    {
      url: '/api/pending',
      get json() {
        onGet?.();
        return [row];
      },
    },
  ]);
}

// Everything here needs the registered DOM and the dynamically imported React
// pieces at call time, so a test file passes them in (see PendingTable.test.tsx).
export interface PendingTableDeps {
  act: typeof ReactAct;
  createElement: typeof ReactCreateElement;
  PendingTable: typeof PendingTableComponent;
  container: () => HTMLElement;
  root: () => Root;
}

export function pendingTableHelpers({ act, createElement: d, PendingTable, container, root }: PendingTableDeps) {
  function confirmButton(): HTMLButtonElement {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Confirm');
    if (!btn) throw new Error('confirm button not found');
    return btn as HTMLButtonElement;
  }

  async function flush() {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  async function renderTable(root: Root) {
    await act(async () => {
      root.render(d(PendingTable, { runId: 7 }));
    });
    await flush();
  }

  async function clickConfirm() {
    await act(async () => {
      confirmButton().click();
    });
    await flush();
  }

  async function pressButton(text: string) {
    const btn = Array.from(container().querySelectorAll('button')).find((b) => b.textContent === text);
    if (!btn) throw new Error(`button ${text} not found`);
    await act(async () => (btn as HTMLButtonElement).click());
    await flush();
  }

  const promptOpen = () => container().querySelector('[role=dialog]') !== null;

  // Edited rows with a screenshot stop at the keep/discard prompt; this walks
  // through it so a test can read the posted body.
  async function confirmKeeping() {
    await clickConfirm();
    await pressButton('Keep for review');
  }

  const cells = () => Array.from(container().querySelectorAll('tbody tr td'));
  const control = <T extends HTMLElement>(idx: number, selector: string) => cells()[idx]!.querySelector(selector) as T;

  async function renderWithConfirmCalls(row: PendingFillDto, postJson: unknown = { ok: true }) {
    const calls = installFetchStub([
      { method: 'POST', url: '/api/pending', json: postJson },
      { url: '/api/pending', json: [row] },
    ]);
    await renderTable(root());
    return calls;
  }

  return { flush, renderTable, clickConfirm, pressButton, promptOpen, confirmKeeping, cells, control, renderWithConfirmCalls };
}
