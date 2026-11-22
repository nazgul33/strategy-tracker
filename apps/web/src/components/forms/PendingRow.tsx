import { api, type PendingFillDto } from '../../api';
import { useT } from '../../i18n';
import { isoDate, priceInputValue } from '../../format';
import { autoFeeUsd } from '../../autofee';
import { feeIsDerived, fieldEditState, standingIssue, type RowField, type RowValues } from '../../pendingvalues';
import { Button, Input, Select, Td } from '../ui';
import { BucketSelect } from './BucketSelect';

// Myriadths → an input value: at least two decimals, more only when the price
// really has them, so an untouched field never reads as an edit.
function priceField(myriadths: string | null | undefined): string {
  if (!myriadths) return '';
  return priceInputValue(myriadths).replace(/(\.\d{2}\d*?)0*$/, '$1');
}

function feeField(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * What the row's controls start with: what vision detected. A fee vision did not
 * read starts as the one the server would derive and keeps tracking qty and price
 * until the operator types a fee (`patchRowValues`).
 */
export function initialRowValues(row: PendingFillDto): RowValues {
  const d = row.detected;
  const shares = d ? d.shares : row.shares;
  const sharesText = shares ? String(shares) : '';
  const price = priceField(d ? d.price : row.price);
  const fee = d ? d.fee : row.fee;
  return {
    filledOn: (d ? d.filledOn : row.filledOn) ?? '',
    side: (d ? d.side : row.side) ?? '',
    shares: sharesText,
    price,
    fee: fee === null ? autoFeeUsd(sharesText, price, row.costPpm) : feeField(fee),
    feeTouched: false,
  };
}

interface PendingRowProps {
  row: PendingFillDto;
  values: RowValues;
  onChange: (patch: Partial<RowValues>) => void;
  bucket: string;
  onBucketChange: (value: string) => void;
  onOpenSideBySide: () => void;
  onConfirm: () => void;
  onReject: () => void;
  busy: boolean;
}

export function PendingRow({
  row,
  values,
  onChange,
  bucket,
  onBucketChange,
  onOpenSideBySide,
  onConfirm,
  onReject,
  busy,
}: PendingRowProps) {
  const t = useT();
  // Flag a field the row is missing until the operator has filled it in.
  const issue = standingIssue(row, values);
  const missing = (f: RowField) => (issue === f ? 'border-warning' : '');
  // Props for a field's control: its width classes, the standing-issue border, and the
  // edit hint. Solid vs dashed plus the title carry the hint, so it never rests on colour.
  const control = (f: RowField, base = '') => {
    const state = fieldEditState(row, values, f);
    const className = `${base} ${missing(f)}`.trim();
    if (state === null) return { className };
    const title = state === 'changed' ? t('pendingFieldChanged') : t(f === 'fee' ? 'pendingFeeErased' : 'pendingFieldErased');
    const look = state === 'changed' ? 'ring-1 ring-inset ring-primary' : 'border-dashed border-warning';
    return { className: `${className} ${look}`, 'data-edit': state, title };
  };
  const needsInput = issue !== null;
  const needsMsg = t(issue === 'ticker' ? 'pendingNeedsTicker' : 'pendingNeedsOverride');
  const captureId = row.hasImage ? row.captureId : null;
  // A blank fee books the derived one on the server, so say which amount.
  const blankFee = values.fee.trim() === '' ? autoFeeUsd(values.shares, values.price, row.costPpm) : '';
  return (
    <tr>
      <Td className="whitespace-nowrap tabular-nums">
        <Input
          type="date"
          {...control('filledOn', 'w-36')}
          value={values.filledOn}
          aria-label={t('pendingColDate')}
          onChange={(e) => onChange({ filledOn: e.target.value })}
        />
      </Td>
      <Td className="font-medium">{row.ticker || '?'}</Td>
      <Td>
        <Select
          {...control('side')}
          value={values.side}
          aria-label={t('pendingColSide')}
          onChange={(e) => onChange({ side: e.target.value })}
        >
          {values.side === '' && <option value="">—</option>}
          <option value="buy">{t('orderSideBuy')}</option>
          <option value="sell">{t('orderSideSell')}</option>
        </Select>
      </Td>
      <Td className="text-right tabular-nums">
        <Input
          {...control('shares', 'w-20 text-right')}
          inputMode="numeric"
          value={values.shares}
          aria-label={t('pendingColQty')}
          onChange={(e) => onChange({ shares: e.target.value })}
        />
      </Td>
      <Td className="text-right tabular-nums">
        <Input
          {...control('price', 'w-28 text-right')}
          inputMode="decimal"
          value={values.price}
          aria-label={t('pendingColPrice')}
          onChange={(e) => onChange({ price: e.target.value })}
        />
      </Td>
      <Td className="text-right tabular-nums">
        <Input
          {...control('fee', 'w-28 text-right')}
          inputMode="decimal"
          value={values.fee}
          placeholder={blankFee ? t('pendingFeeAutoPlaceholder', { fee: blankFee }) : undefined}
          aria-label={t('pendingColFee')}
          onChange={(e) => onChange({ fee: e.target.value })}
        />
        {feeIsDerived(row, values) && (
          <div data-auto-fee title={t('pendingFeeAutoHint')} className="text-xs text-muted-foreground">
            {t('pendingFeeAuto')}
          </div>
        )}
      </Td>
      <Td>
        {values.side === 'sell' && (
          <BucketSelect aria-label={t('fillBucket')} value={bucket} held={row.heldBuckets} onChange={onBucketChange} />
        )}
      </Td>
      <Td>
        {captureId !== null && (
          <div className="flex flex-col items-start gap-1">
            <img
              src={api.captureImageUrl(captureId)}
              alt={t('pendingScreenshotAlt')}
              loading="lazy"
              className="h-12 w-20 rounded border border-border object-cover object-top"
            />
            <Button onClick={onOpenSideBySide}>{t('pendingCompare')}</Button>
          </div>
        )}
      </Td>
      <Td className="whitespace-nowrap text-muted-foreground tabular-nums">{isoDate(row.createdAt)}</Td>
      <Td className="sticky right-0 bg-card pl-3">
        {needsInput && <div className="mb-1 max-w-48 text-xs text-warning">{needsMsg}</div>}
        <div className="flex gap-2">
          <Button variant="primary" busy={busy} onClick={onConfirm}>
            {t('pendingConfirm')}
          </Button>
          <Button variant="danger" disabled={busy} onClick={onReject}>
            {t('pendingReject')}
          </Button>
        </div>
      </Td>
    </tr>
  );
}
