import { describe, expect, test } from 'bun:test';
import { parseUsd } from '@st/core';
import { DEFAULT_VR_SETTINGS } from '@st/strategies/value-rebalancing';
import type { OrderRecord } from '../src/domain/repo-types';
import { activeRun, makeCapture } from './wire-capture-fakes';

type Harness = ReturnType<typeof makeCapture>;

// Reference VR run: 177 shares, Pool $800.00, cycle 1 from 2026-11-02 with V $9350.00.
async function seedVr(h: Harness): Promise<number> {
  const runId = await h.repos.vrRunRepo.create({
    ...DEFAULT_VR_SETTINGS, ticker: 'TQQQ', name: 'Q', costPpm: 0, initialVCents: 935000, openingCashCents: 965000, openedOn: '2026-10-30',
  });
  await h.repos.vrFillRepo.insert({ runId, side: 'buy', shares: 177, price: 500_000n, fee: 0, filledOn: '2026-10-30', source: 'manual' });
  await h.repos.vrCycleRepo.open(
    {
      runId, seq: 1, scheduledStart: '2026-11-02', startDate: '2026-11-02', vCents: 935000, bandMinCents: 794750, bandMaxCents: 1075250,
      openShares: 177, openPoolCents: 80000, buyBudgetCents: 40000, buyLot: 3, sellLot: 2,
      prevClose: null, evalCents: null, poolBeforeCents: null, g: 10, formula: 'skill', depositCents: 0, vKept: false,
    },
    null,
  );
  return runId;
}

const VR_STATUS = 'VR run #100001 TQQQ\nShares: 177  Pool: $800.00\nV: $9350.00  Band: $7947.50 – $10752.50';
const VR_ORDERS = [
  'VR run #100001 TQQQ',
  'Buy 3 rungs, 3 sh each:',
  '$44.90  $44.15  $43.42',
  'Sell 22 rungs, 2 sh each:',
  '$60.75  $61.45  $62.16  $62.89  $63.63',
  '$64.39  $65.17  $65.97  $66.79  $67.63',
  '$68.49  $69.38  $70.28  $71.21  $72.17',
  '$73.15  $74.16  $75.20  $76.26  $77.36',
  '$78.49  $79.65',
].join('\n');

const mrOrder: OrderRecord = {
  id: 1, runId: 1, bucketIdx: 0, kind: 'buy_loc', limitPrice: parseUsd('170.00'), shares: 10, tradeDate: '2026-11-10',
  status: 'open', skipReason: null, cancelReason: null, reportedAt: null,
};

describe('VR blocks in /status', () => {
  test('after the MR blocks, which are unchanged', async () => {
    const plain = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await plain.handlers.onStatus('777');
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await seedVr(h);
    await h.handlers.onStatus('777');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toBe(plain.sent[0]!.text + '\n\n' + VR_STATUS);
  });

  test('with only a VR run it is the VR block, not the no-runs text', async () => {
    const h = makeCapture({ runs: [] });
    await seedVr(h);
    await h.handlers.onStatus('777');
    expect(h.sent[0]!.text).toBe(VR_STATUS);
  });

  test('a VR run without a cycle shows no V; a paused run is left out', async () => {
    const h = makeCapture({ runs: [] });
    const id = await h.repos.vrRunRepo.create({ ...DEFAULT_VR_SETTINGS, ticker: 'TQQQ', name: 'Q', costPpm: 0, initialVCents: 500000, openingCashCents: 1000000, openedOn: '2026-10-30' });
    await h.handlers.onStatus('777');
    expect(h.sent[0]!.text).toBe('VR run #100001 TQQQ\nShares: 0  Pool: $10000.00\nNo cycle yet');
    await h.repos.vrRunRepo.updateStatus(id, 'paused');
    await h.handlers.onStatus('777');
    expect(h.sent[1]!.text).toBe('No runs yet — start one from the web app.');
  });

  test('Korean', async () => {
    const h = makeCapture({ runs: [], lang: 'ko' });
    await seedVr(h);
    await h.handlers.onStatus('777');
    expect(h.sent[0]!.text).toBe('VR 런 #100001 TQQQ\n보유: 177주  Pool: $800.00\nV: $9350.00  밴드: $7947.50 – $10752.50');
  });
});

describe('VR blocks in /orders', () => {
  test('after the MR orders', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await seedVr(h);
    h.repos.orderRepo.listForDate = async () => [mrOrder];
    await h.handlers.onOrders('777');
    expect(h.sent[0]!.text).toBe('Run #1 NVDA\n#1 buy_loc 10 sh @ $170.00\n\n' + VR_ORDERS);
  });

  test('with only a VR run it is the VR block', async () => {
    const h = makeCapture({ runs: [] });
    await seedVr(h);
    await h.handlers.onOrders('777');
    expect(h.sent[0]!.text).toBe(VR_ORDERS);
  });

  test('a VR run without a cycle adds nothing, so the no-orders text stays', async () => {
    const h = makeCapture({ runs: [] });
    await h.repos.vrRunRepo.create({ ...DEFAULT_VR_SETTINGS, ticker: 'TQQQ', name: 'Q', costPpm: 0, initialVCents: 500000, openingCashCents: 1000000, openedOn: '2026-10-30' });
    await h.handlers.onOrders('777');
    expect(h.sent[0]!.text).toBe('No orders due on 2026-11-10.');
  });

  test('a run that holds no shares has no ladder to list', async () => {
    const h = makeCapture({ runs: [] });
    const id = await seedVr(h);
    await h.repos.vrFillRepo.insert({ runId: id, side: 'sell', shares: 177, price: 500_000n, fee: 0, filledOn: '2026-11-03', source: 'manual' });
    await h.handlers.onOrders('777');
    expect(h.sent[0]!.text).toBe('No orders due on 2026-11-10.');
  });

  test('a partial fill in the cycle makes the buy side list each rung', async () => {
    const h = makeCapture({ runs: [] });
    const id = await seedVr(h);
    await h.repos.vrFillRepo.insert({ runId: id, side: 'buy', shares: 1, price: 450_000n, fee: 0, filledOn: '2026-11-05', source: 'manual' });
    await h.handlers.onOrders('777');
    expect(h.sent[0]!.text).toContain('Buy 3 rungs:\n2 sh @ $44.90\n3 sh @ $44.15\n3 sh @ $43.42\n');
  });

  test('a paused run is left out', async () => {
    const h = makeCapture({ runs: [] });
    const id = await seedVr(h);
    await h.repos.vrRunRepo.updateStatus(id, 'paused');
    await h.handlers.onOrders('777');
    expect(h.sent[0]!.text).toBe('No orders due on 2026-11-10.');
  });
});
