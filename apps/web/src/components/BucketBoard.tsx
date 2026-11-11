// Bucket board: every slot rendered (empty ones too) so run capacity is
// visible. Force-sell rows get a highlighted `tr` — the strategy force-closes
// at day maxAgeDays, so age >= maxAgeDays renders as warning.
import type { BucketDto } from '../api';
import { bucketCells, type BadgeTone } from '../viewmodels';
import { centsUsd, priceUsd } from '../format';
import { useT } from '../i18n';
import { Badge, EmptyNote, TableWrap, Td, Th } from './ui';

const STATE_TONE: Record<BucketDto['state'], BadgeTone> = {
  empty: 'neutral',
  held: 'primary',
  force_sell: 'warning',
};

/** Display default; real value lives in run params (maxAgeDays). */
export const DEFAULT_MAX_AGE_DAYS = 5;

export function BucketBoard({
  buckets,
  ages,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
}: {
  buckets: BucketDto[];
  ages: Record<string, number>;
  maxAgeDays?: number;
}) {
  const t = useT();
  if (buckets.length === 0) return <EmptyNote>{t('bucketEmpty')}</EmptyNote>;
  const cells = bucketCells(buckets, ages, buckets.length, maxAgeDays);
  return (
    <TableWrap>
      <thead>
        <tr>
          <Th>{t('bucketLabel')}</Th>
          <Th>{t('runColStatus')}</Th>
          <Th className="text-right">{t('bucketShares')}</Th>
          <Th className="text-right">{t('bucketBuyPrice')}</Th>
          <Th className="text-right">{t('bucketAgeDays')}</Th>
          <Th className="text-right">{t('fillColValue')}</Th>
        </tr>
      </thead>
      <tbody>
        {cells.map((cell) => (
          <tr key={cell.index} className={cell.forceSell ? 'bg-warning/10' : undefined}>
            <Td className="font-medium tabular-nums">{cell.index + 1}</Td>
            <Td>
              <Badge tone={STATE_TONE[cell.state]}>
                {cell.state === 'force_sell'
                  ? t('bucketForceSell')
                  : cell.state === 'held'
                    ? t('runColHeld')
                    : t('bucketEmpty')}
              </Badge>
            </Td>
            <Td className="text-right tabular-nums">{cell.filled ? cell.shares : '—'}</Td>
            <Td className="text-right tabular-nums">{cell.buyPrice ? priceUsd(cell.buyPrice) : '—'}</Td>
            <Td className={`text-right tabular-nums ${cell.forceSell ? 'text-warning' : ''}`}>
              {cell.ageDays ?? '—'}
            </Td>
            <Td className="text-right tabular-nums">
              {cell.notionalCents !== null ? centsUsd(cell.notionalCents) : '—'}
            </Td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}
