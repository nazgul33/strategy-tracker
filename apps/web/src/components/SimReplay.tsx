// Day-by-day replay of a sim run. Arrow keys / ◀ ▶ step the window; the day
// card shows that morning's plan, fills grouped by bucket, and the state
// snapshot. Force-sell buckets (last tradable day) are highlighted.
import { useEffect, useState } from 'react';

import type { SimDayDto, SimEvent, SimRunDto } from '../api';
import {
  enumLabelKey,
  pnlBadgeTone,
  reasonKey,
  simEventGroup,
  toneFor,
  type BadgeTone,
  type SimGroup,
} from '../viewmodels';
import { centsUsd, priceUsd, bpPercent, isoDate, signedCentsUsd } from '../format';
import { useT } from '../i18n';
import { Badge, Button, Card, EmptyNote, SectionTitle, Stat, TableWrap, Td, Th } from './ui';
import { BucketBoard } from './BucketBoard';
import { closedPnlCents } from './RunHistory';

const GROUP_TONE: Record<SimGroup, BadgeTone> = {
  buy: 'info',
  target: 'primary',
  force: 'warning',
  skipped: 'neutral',
};
const GROUP_LABEL: Record<SimGroup, string> = {
  buy: 'simReasonBuy',
  target: 'simReasonTarget',
  force: 'simReasonForceClose',
  skipped: 'simReasonSkip',
};

interface SimParams {
  bucketCount: number;
  maxAgeDays: number;
  sellCapBps: number | null;
}

function parseParams(paramsJson: string, fallbackBucketCount: number): SimParams {
  try {
    const raw = JSON.parse(paramsJson) as { bucketCount?: number; maxAgeDays?: number; sellCapBps?: number };
    return {
      bucketCount: typeof raw.bucketCount === 'number' && raw.bucketCount > 0 ? raw.bucketCount : fallbackBucketCount,
      maxAgeDays: typeof raw.maxAgeDays === 'number' && raw.maxAgeDays > 0 ? raw.maxAgeDays : 20,
      sellCapBps: typeof raw.sellCapBps === 'number' ? raw.sellCapBps : null,
    };
  } catch {
    return { bucketCount: fallbackBucketCount, maxAgeDays: 20, sellCapBps: null };
  }
}

/** Consecutive fills/skips sharing one bucket fold into one group. */
function groupEvents(events: SimEvent[], isLastDay: boolean): { group: SimGroup; bucketIndex: number; events: SimEvent[] }[] {
  const out: { group: SimGroup; bucketIndex: number; events: SimEvent[] }[] = [];
  for (const event of events) {
    const group = simEventGroup(event, isLastDay);
    const last = out[out.length - 1];
    if (last && last.group === group && last.bucketIndex === event.bucketIndex) last.events.push(event);
    else out.push({ group, bucketIndex: event.bucketIndex, events: [event] });
  }
  return out;
}

export function SimReplay({ run, days }: { run: SimRunDto; days: SimDayDto[] }) {
  const t = useT();
  const [idx, setIdx] = useState(days.length - 1);
  const total = days.length;

  useEffect(() => {
    setIdx(total > 0 ? total - 1 : 0);
  }, [total]);

  const step = (delta: number) => setIdx((i) => Math.min(Math.max(i + delta, 0), total - 1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total]);

  if (total === 0) return <EmptyNote>{t('simEmpty')}</EmptyNote>;
  const clamped = Math.min(idx, total - 1);
  const day = days[clamped]!;
  const isLast = clamped === total - 1;
  const params = parseParams(run.paramsJson, day.stateJson.buckets.length);
  const state = day.stateJson;
  const held = state.buckets.filter((b) => b.shares > 0).length;
  const realizedCents = state.closed.reduce((sum, c) => sum + closedPnlCents(c), 0);
  // Mark-to-cost valuation of open positions (myriadths × shares → cents).
  const holdingsCents = Number(
    state.buckets.reduce(
      (sum, b) => (b.shares > 0 && b.buyPrice ? sum + BigInt(b.buyPrice) * BigInt(b.shares) : sum),
      0n,
    ) / 100n,
  );
  const finalValueCents = state.cashCents + holdingsCents;
  const realizedTone = pnlBadgeTone(toneFor(realizedCents));
  const groups = groupEvents(day.eventsJson, isLast);

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={() => step(-1)} disabled={clamped === 0} aria-label={t('simPrevDay')}>
          ◀ {t('simPrevDay')}
        </Button>
        <span className="text-sm font-medium tabular-nums">
          {t('simDayNav', { n: clamped + 1, total })} — {isoDate(day.tradeDate)}
        </span>
        <Button variant="secondary" onClick={() => step(1)} disabled={isLast} aria-label={t('simNextDay')}>
          {t('simNextDay')} ▶
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {run.ticker} · {isoDate(run.fromDate)} → {isoDate(run.toDate)} · {t('runPoolCents')} {centsUsd(run.poolCents)}
          {params.sellCapBps !== null && <> · {t('simSellCap')} {bpPercent(params.sellCapBps * 100)}</>}
          {` · ${t('simMaxAge')} ${params.maxAgeDays}`}
        </span>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t('simOpen')} value={`${held}/${params.bucketCount}`} />
        <Stat label={t('runColCash')} value={centsUsd(state.cashCents)} />
        <Stat label={t('simFinalValue')} value={centsUsd(finalValueCents)} sub={t('historyColBuy')} />
        <Stat label={t('statRealized')} value={signedCentsUsd(realizedCents)} tone={realizedTone} />
      </div>

      <Card>
        <SectionTitle>{t('simPlanOrders')} — {isoDate(day.tradeDate)}</SectionTitle>
        {day.planJson.orders.length === 0 && day.planJson.skips.length === 0 ? (
          <EmptyNote>{t('simNoFills')}</EmptyNote>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('orderColSide')}</Th>
                <Th className="text-right">{t('fillColBucket')}</Th>
                <Th className="text-right">{t('orderColPrice')}</Th>
                <Th className="text-right">{t('orderColQty')}</Th>
              </tr>
            </thead>
            <tbody>
              {day.planJson.orders.map((o, i) => (
                <tr key={`o${i}`}>
                  <Td>
                    <Badge tone={o.kind === 'buy_loc' ? 'info' : o.kind === 'sell_loc' ? 'primary' : 'warning'}>
                      {t(enumLabelKey('orderKind', o.kind))}
                    </Badge>
                  </Td>
                  <Td className="text-right tabular-nums">{o.bucketIndex + 1}</Td>
                  <Td className="text-right tabular-nums">{priceUsd(o.limitPrice)}</Td>
                  <Td className="text-right tabular-nums">{o.shares}</Td>
                </tr>
              ))}
              {day.planJson.skips.map((o, i) => (
                <tr key={`s${i}`} className="opacity-60">
                  <Td>
                    <Badge tone="neutral">{t('orderStatusCancelled')}</Badge>
                  </Td>
                  <Td className="text-right tabular-nums">{o.bucketIndex + 1}</Td>
                  <Td className="text-right tabular-nums">{priceUsd(o.limitPrice)}</Td>
                  <Td className="text-right tabular-nums">{o.shares}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
        {day.planJson.notices.length > 0 && (
          <div className="mt-3 space-y-1 text-xs text-muted-foreground">
            {day.planJson.notices.map((n, i) => (
              <div key={i}>{t(`digest.${n.code}`, n.params)}</div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle>{t('simEvents')}</SectionTitle>
        {groups.length === 0 ? (
          <EmptyNote>{t('simNoFills')}</EmptyNote>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('simFillSide')}</Th>
                <Th className="text-right">{t('fillColBucket')}</Th>
                <Th className="text-right">{t('simFillShares')}</Th>
                <Th className="text-right">{t('simFillPrice')}</Th>
                <Th className="text-right">{t('fillColFee')}</Th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g, gi) =>
                g.events.map((ev, ei) => (
                  <tr key={`${gi}-${ei}`} className={g.group === 'force' ? 'bg-warning/10' : undefined}>
                    <Td>
                      {ei === 0 ? (
                        <Badge tone={GROUP_TONE[g.group]}>{t(GROUP_LABEL[g.group])}</Badge>
                      ) : (
                        <span className="text-muted-foreground">·</span>
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">{t('bucketLabel', { n: ev.bucketIndex + 1 })}</Td>
                    {ev.type === 'skipped' ? (
                      <Td colSpan={3} className="text-muted-foreground">
                        {t(reasonKey('simSkip', ev.reason))}
                      </Td>
                    ) : (
                      <>
                        <Td className="text-right tabular-nums">{ev.shares}</Td>
                        <Td className="text-right tabular-nums">{priceUsd(ev.price)}</Td>
                        <Td className="text-right tabular-nums">{centsUsd(ev.feeCents)}</Td>
                      </>
                    )}
                  </tr>
                )),
              )}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <Card>
        <SectionTitle>{t('bucketBoard')}</SectionTitle>
        <BucketBoard buckets={state.buckets} ages={state.ages} maxAgeDays={params.maxAgeDays} />
      </Card>
    </div>
  );
}
