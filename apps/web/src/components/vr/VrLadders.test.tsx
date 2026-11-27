// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { VrRunDetailDto } from '../../api.vr.types';
import { VR_DETAIL, vrDetail } from '../../testing/vr';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { VrLadders } = await import('./VrLadders');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

const EMPTY = { buy: [], sell: [], buyTotal: 0, sellTotal: 0 };
const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const rows = (id: string) =>
  [...document.querySelectorAll(`[data-testid="${id}"] tbody tr`)].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));

describe('VrLadders', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const render = (detail: VrRunDetailDto) => act(async () => root.render(d(VrLadders, { detail })));
  const only = (shown: string) => {
    for (const id of ['vrBuyInstruction', 'vrBuyPending', 'vrLadderNextCycle', 'vrBuyLadder', 'vrSellLadder']) {
      if (id === shown || (shown === 'ladders' && (id === 'vrBuyLadder' || id === 'vrSellLadder'))) {
        expect(byId(id), id).not.toBeNull();
      } else {
        expect(byId(id), id).toBeNull();
      }
    }
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('lists every open rung of both sides with shares and price columns', async () => {
    await render(VR_DETAIL);
    only('ladders');
    expect([...document.querySelectorAll('[data-testid="vrBuyLadder"] th')].map((th) => th.textContent)).toEqual(['Shares', 'Price']);
    expect([...document.querySelectorAll('[data-testid="vrSellLadder"] th')].map((th) => th.textContent)).toEqual(['Shares', 'Price']);
    expect(rows('vrBuyLadder')).toEqual([
      ['3', '$44.39'],
      ['3', '$43.66'],
    ]);
    expect(byId('vrBuyLadder')!.querySelector('h3')!.textContent).toContain('Buy ladder · 2 of 3 rungs left');
    const sell = rows('vrSellLadder');
    expect(sell).toHaveLength(22);
    expect(sell.slice(0, 2)).toEqual([
      ['2', '$61.10'],
      ['2', '$61.80'],
    ]);
    expect(sell[21]).toEqual(['2', '$80.25']);
    expect(byId('vrSellLadder')!.querySelector('h3')!.textContent).toContain('22 of 22 rungs left');
  });

  it('says so when a side has no open rungs', async () => {
    await render(vrDetail({ ladder: { ...VR_DETAIL.ladder, sell: [], sellTotal: 22 } }));
    const sell = byId('vrSellLadder')!;
    expect(sell.textContent).toContain('0 of 22 rungs left');
    expect(sell.textContent).toContain('No open rungs.');
    expect(sell.querySelector('tbody')).toBeNull();
    expect(rows('vrBuyLadder')).toHaveLength(2);
  });

  it('shows a partly filled rung with its remaining shares', async () => {
    await render(vrDetail({ ladder: { ...VR_DETAIL.ladder, sell: [{ shares: 1, price: '618000' }, ...VR_DETAIL.ladder.sell.slice(1)] } }));
    expect(rows('vrSellLadder')[0]).toEqual(['1', '$61.80']);
  });

  it('shows the buy instruction instead of the ladders', async () => {
    await render(
      vrDetail({
        books: { ...VR_DETAIL.books, shares: 0 },
        buyInstruction: { shares: 203, targetCents: 935_000 },
        ladder: EMPTY,
      }),
    );
    only('vrBuyInstruction');
    expect(byId('vrBuyInstruction')!.textContent).toBe('Buy 203 shares, about $9,350.00 at the last close of $46.00 on 2026-12-08.');
  });

  it('says the target is below one share instead of "buy 0 shares"', async () => {
    await render(
      vrDetail({
        books: { ...VR_DETAIL.books, shares: 0 },
        buyInstruction: { shares: 0, targetCents: 4_000 },
        ladder: EMPTY,
      }),
    );
    only('vrBuyInstruction');
    expect(byId('vrBuyInstruction')!.textContent).toBe(
      'The target of $40.00 is less than the price of one share at the last close of $46.00 on 2026-12-08, so there is nothing to buy yet.',
    );
  });

  it('says the instruction arrives with the morning message when there is no shares and no close', async () => {
    await render(
      vrDetail({
        cycle: null,
        lastClose: null,
        buyInstruction: null,
        budgetLeftCents: null,
        books: { ...VR_DETAIL.books, shares: 0 },
        ladder: EMPTY,
      }),
    );
    only('vrBuyPending');
    expect(byId('vrBuyPending')!.textContent).toBe("No closing price stored yet. It is stored after the next session's close or by the next morning's job, and the buy instruction follows.");
  });

  it('says the ladder arrives with the next cycle when shares are held before cycle 1', async () => {
    await render(vrDetail({ cycle: null, budgetLeftCents: null, ladder: EMPTY }));
    only('vrLadderNextCycle');
    expect(byId('vrLadderNextCycle')!.textContent).toBe('The ladder starts with the next cycle.');
  });

  it('says the same for a cycle that opened with no shares', async () => {
    await render(vrDetail({ cycle: { ...VR_DETAIL.cycle!, openShares: 0 }, ladder: EMPTY }));
    only('vrLadderNextCycle');
  });
});
