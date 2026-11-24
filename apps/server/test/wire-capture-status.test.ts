import { describe, expect, test } from 'bun:test';
import { parseUsd } from '@st/core';
import type { OrderRecord } from '../src/domain/repo-types';
import { activeRun, makeCapture } from './wire-capture-fakes';

describe('capture status and orders', () => {
  test('onStatus renders the run progress view', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.handlers.onStatus('777');
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.text).toMatch(/Run #1 NVDA/);
    expect(h.sent[0]!.text).toContain('Cash: $10000.00');
    const count = h.stateFor(1).buckets.length;
    expect(h.sent[0]!.text).toContain('Bucket 1: idle');
    expect(h.sent[0]!.text).toContain(`Bucket ${count}: idle`);
    expect(h.sent[0]!.text).not.toContain('Bucket 0:');
  });

  test('onStatus explains when there are no runs', async () => {
    const h = makeCapture({ runs: [] });
    await h.handlers.onStatus('777');
    expect(h.sent[0]!.text).toBe('No runs yet — start one from the web app.');
  });

  test('minor-2: onStatus omits non-active (archived) runs', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA'), { ...activeRun(2, 'AAPL'), status: 'closed' }] });
    await h.handlers.onStatus('777');
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.text).toContain('Run #1 NVDA');
    expect(h.sent[0]!.text).not.toContain('Run #2');
  });

  test('onOrders lists orders due today and says so when empty', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA'), { ...activeRun(2, 'AAPL'), status: 'closed' }] });
    await h.handlers.onOrders('777');
    expect(h.sent[0]!.text).toBe('No orders due on 2026-11-10.');

    const base = { bucketIdx: 0, tradeDate: '2026-11-10', status: 'open', skipReason: null, cancelReason: null, reportedAt: null } as const;
    const orders: OrderRecord[] = [
      { ...base, id: 1, runId: 1, kind: 'buy_loc', limitPrice: parseUsd('170.00'), shares: 10 },
      { ...base, id: 2, runId: 2, kind: 'sell_loc', limitPrice: parseUsd('200.00'), shares: 5 },
      { ...base, id: 3, runId: 9, kind: 'buy_loc', limitPrice: parseUsd('50.00'), shares: 1 },
    ];
    h.repos.orderRepo.listForDate = async () => orders;
    await h.handlers.onOrders('777');
    expect(h.sent[1]!.text).toBe(
      'Run #1 NVDA\n#1 buy_loc 10 sh @ $170.00\n\nRun #2 AAPL\n#2 sell_loc 5 sh @ $200.00\n\nrun #9\n#3 buy_loc 1 sh @ $50.00',
    );
  });

  test('onOrders tells two runs on the same ticker apart, ordered by run id', async () => {
    const h = makeCapture({ runs: [activeRun(3, 'NVDA'), activeRun(1, 'NVDA')] });
    const base = { bucketIdx: 0, tradeDate: '2026-11-10', status: 'open', skipReason: null, cancelReason: null, reportedAt: null } as const;
    const orders: OrderRecord[] = [
      { ...base, id: 1, runId: 3, kind: 'buy_loc', limitPrice: parseUsd('170.00'), shares: 10 },
      { ...base, id: 2, runId: 1, kind: 'sell_loc', limitPrice: parseUsd('200.00'), shares: 5 },
      { ...base, id: 3, runId: 3, kind: 'sell_loc', limitPrice: parseUsd('190.00'), shares: 10 },
    ];
    h.repos.orderRepo.listForDate = async () => orders;
    await h.handlers.onOrders('777');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toBe(
      'Run #1 NVDA\n#2 sell_loc 5 sh @ $200.00\n\nRun #3 NVDA\n#1 buy_loc 10 sh @ $170.00\n#3 sell_loc 10 sh @ $190.00',
    );
  });

  test('onOrders renders the run header in Korean', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')], lang: 'ko' });
    const order: OrderRecord = { id: 1, runId: 1, bucketIdx: 0, kind: 'buy_loc', limitPrice: parseUsd('170.00'), shares: 10, tradeDate: '2026-11-10', status: 'open', skipReason: null, cancelReason: null, reportedAt: null };
    h.repos.orderRepo.listForDate = async () => [order];
    await h.handlers.onOrders('777');
    expect(h.sent[0]!.text).toBe('런 #1 NVDA\n#1 buy_loc 10주 @ $170.00');
  });

  test('onOrders names a missing run in Korean', async () => {
    const h = makeCapture({ runs: [], lang: 'ko' });
    const order: OrderRecord = { id: 3, runId: 9, bucketIdx: 0, kind: 'buy_loc', limitPrice: parseUsd('50.00'), shares: 1, tradeDate: '2026-11-10', status: 'open', skipReason: null, cancelReason: null, reportedAt: null };
    h.repos.orderRepo.listForDate = async () => [order];
    await h.handlers.onOrders('777');
    expect(h.sent[0]!.text).toBe('런 #9\n#3 buy_loc 1주 @ $50.00');
  });
});
