// Closed buckets ("history"): P&L derived from the booked fill numbers only
// (myriadths bigint math, never floats) — display of what the server booked.
import type { ClosedBucketDto } from '../api';
import { daysBetween, toneFor, pnlBadgeTone } from '../viewmodels';
import { isoDate, priceUsd, signedCentsUsd } from '../format';
import { useT } from '../i18n';
import { Badge, EmptyNote, TableWrap, Td, Th } from './ui';

const TEXT_TONE = { positive: 'text-positive', negative: 'text-destructive', neutral: '' } as const;

/** (sold − buy) × shares − fees, on myriadths strings → integer cents. */
export function closedPnlCents(c: ClosedBucketDto): number {
  const pnlMyriadths =
    (BigInt(c.soldPrice) - BigInt(c.buyPrice)) * BigInt(c.shares) - BigInt(c.buyFeeCents + c.sellFeeCents) * 100n;
  const rounded = pnlMyriadths >= 0n ? (pnlMyriadths + 50n) / 100n : (pnlMyriadths - 50n) / 100n;
  return Number(rounded);
}

export function RunHistory({ closed }: { closed: ClosedBucketDto[] }) {
  const t = useT();
  if (closed.length === 0) return <EmptyNote>{t('historyEmpty')}</EmptyNote>;
  return (
    <TableWrap>
      <thead>
        <tr>
          <Th className="text-right">{t('historyColBucket')}</Th>
          <Th>{t('historyColOpen')}</Th>
          <Th>{t('historyColClose')}</Th>
          <Th className="text-right">{t('historyColShares')}</Th>
          <Th className="text-right">{t('historyColBuy')}</Th>
          <Th className="text-right">{t('historyColSell')}</Th>
          <Th className="text-right">{t('historyColPnl')}</Th>
          <Th className="text-right">{t('historyColDays')}</Th>
        </tr>
      </thead>
      <tbody>
        {closed.map((c) => {
          const pnl = closedPnlCents(c);
          const tone = toneFor(pnl);
          return (
            <tr key={`${c.index}-${c.closedOn}`}>
              <Td className="text-right tabular-nums">{c.index + 1}</Td>
              <Td className="whitespace-nowrap tabular-nums">{isoDate(c.openedOn)}</Td>
              <Td className="whitespace-nowrap tabular-nums">{isoDate(c.closedOn)}</Td>
              <Td className="text-right tabular-nums">{c.shares}</Td>
              <Td className="text-right tabular-nums">{priceUsd(c.buyPrice)}</Td>
              <Td className="text-right tabular-nums">{priceUsd(c.soldPrice)}</Td>
              <Td className="text-right">
                <Badge tone={pnlBadgeTone(tone)}>
                  <span className={TEXT_TONE[tone]}>{signedCentsUsd(pnl)}</span>
                </Badge>
              </Td>
              <Td className="text-right tabular-nums">{daysBetween(c.openedOn, c.closedOn)}</Td>
            </tr>
          );
        })}
      </tbody>
    </TableWrap>
  );
}
