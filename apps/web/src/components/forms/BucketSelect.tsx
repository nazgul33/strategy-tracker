import type { HeldBucketDto } from '../../api';
import { useT } from '../../i18n';
import { Select } from '../ui';

// Which bucket a sell is booked to. value '' = Automatic, otherwise the bucket
// index as text. A choice that is no longer held stays listed (and is sent), so
// the server's bucket-not-held answer explains it instead of the choice vanishing.
export function BucketSelect({
  value,
  held,
  onChange,
  invalid,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
  'data-testid': testId,
}: {
  value: string;
  held: HeldBucketDto[];
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
          {`${t('bucketLabel', { n: b.index })} · ${t('bucketShares', { shares: b.shares })}`}
        </option>
      ))}
      {stale && <option value={value}>{t('bucketLabel', { n: value })}</option>}
    </Select>
  );
}
