import type { HeldBucketDto } from '../../api';
import { useT } from '../../i18n';
import { Select } from '../ui';

// Which bucket a fill is booked to (a sell closes it, a buy is added to it). value '' = Automatic, otherwise the bucket's
// stored 0-based index as text (what gets posted as bucketIdx). The label shows
// index + 1, the number the bucket board and the fill/order tables show. A choice
// that is no longer held stays listed (and is sent), so the server's
// bucket-not-held answer explains it instead of the choice vanishing.
export function BucketSelect({
  value,
  held,
  side,
  onChange,
  invalid,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
  'data-testid': testId,
}: {
  value: string;
  held: HeldBucketDto[];
  side: 'buy' | 'sell';
  onChange: (value: string) => void;
  invalid?: boolean;
  'aria-label': string;
  'aria-describedby'?: string;
  'data-testid'?: string;
}) {
  const t = useT();
  const stale = value !== '' && !held.some((b) => String(b.index) === value);
  return (
    <Select
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      className={invalid ? 'border-warning' : undefined}
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{t('fillBucketAuto')}</option>
      {held.map((b) => (
        <option key={b.index} value={String(b.index)}>
          {side === 'buy'
            ? t('bucketAddTo', { n: b.index + 1, shares: b.shares })
            : `${t('bucketLabel', { n: b.index + 1 })} · ${t('bucketShares', { shares: b.shares })}`}
        </option>
      ))}
      {stale && <option value={value}>{t('bucketLabel', { n: Number(value) + 1 })}</option>}
    </Select>
  );
}
