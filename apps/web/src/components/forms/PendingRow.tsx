import { api, type PendingFillDto } from '../../api';
import { useT } from '../../i18n';
import { isoDate, priceInputValue } from '../../format';
import { autoFeeUsd } from '../../autofee';
import { bucketRequired, dateAfterToday, orderLine } from '../../pendingchoice';
import { feeIsDerived, standingIssues, type RowField, type RowValues } from '../../pendingvalues';
import { Button, Input, Select, Td } from '../ui';
import { BucketSelect } from './BucketSelect';
import { editHint } from './pendingHints';

const HINT_CLASS =
  'sr-only peer-focus:not-sr-only peer-focus:mt-1 peer-focus:block peer-focus:max-w-48 peer-focus:whitespace-normal peer-focus:text-left peer-focus:text-[11px] peer-focus:leading-snug peer-focus:text-muted-foreground';

// The header cells in `PendingTable`; the needs-input row spans them all.
const COLUMNS = 10;

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
  /** The server refused this row's last confirm with `choose-bucket`. */
  bucketRefused: boolean;
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
  bucketRefused,
  onOpenSideBySide,
  onConfirm,
  onReject,
  busy,
}: PendingRowProps) {
  const t = useT();
  // Every missed field is flagged until the operator has filled it in.
  const issues = standingIssues(row, values);
  const dateLate = dateAfterToday(row, values);
  const bucketAsked = bucketRequired(row, values, bucket, bucketRefused);
  const missing = (f: RowField) =>
    (issues as readonly string[]).includes(f) || (f === 'filledOn' && dateLate) ? 'border-warning' : '';
  const hintId = (f: RowField) => `pending-${row.id}-${f}-hint`;
  // Props for a field's control: its width classes, the standing-issue border, and the
  // edit hint. Solid vs dashed carries the state without colour; the title is the mouse
  // hover, and aria-describedby points at the hint span `hint(f)` renders after it.
  const control = (f: RowField, base = '') => {
    const h = editHint(row, values, f);
    const className = `${base} ${missing(f)}`.trim();
    if (h === null) return { className };
    const props = {
      className: `${className} ${h.look} peer`.replace(/\s+/g, ' ').trim(),
      title: t(h.key),
      'aria-describedby': hintId(f),
    };
    return h.state === 'auto' ? props : { ...props, 'data-edit': h.state };
  };
  // Hidden at rest, shown under the control while it has focus (a tap focuses the input);
  // screen readers get it as the control's description either way.
  const hint = (f: RowField) => {
    const h = editHint(row, values, f);
    if (h === null) return null;
    return (
      <span id={hintId(f)} data-hint className={HINT_CLASS}>
        {t(h.key)}
      </span>
    );
  };
  const needsInput = issues.length > 0 || dateLate || bucketAsked;
  const needsMsg = t(issues.includes('ticker') ? 'pendingNeedsTicker' : 'pendingNeedsOverride');
  const needsId = `pending-${row.id}-needs`;
  const bucketNeedsId = `pending-${row.id}-bucket-needs`;
  const order = orderLine(row.detected);
  const captureId = row.hasImage ? row.captureId : null;
  // A blank fee books the derived one on the server, so say which amount.
  const blankFee = values.fee.trim() === '' ? autoFeeUsd(values.shares, values.price, row.costPpm) : '';
  return (
    <>
      <tr>
        <Td className="whitespace-nowrap tabular-nums">
          <Input
            type="date"
            {...control('filledOn', 'w-36')}
            value={values.filledOn}
            aria-label={t('pendingColDate')}
            onChange={(e) => onChange({ filledOn: e.target.value })}
          />
          {hint('filledOn')}
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
          {hint('side')}
          {order && (
            <div data-order-line className="mt-1 text-xs text-muted-foreground">
              {order.type !== null && <div>{order.type}</div>}
              {(order.shares !== null || order.price !== null) && (
                <div>
                  {t('pendingOrderLine', {
                    shares: order.shares ?? '—',
                    price: order.price === null ? '—' : priceField(order.price),
                  })}
                </div>
              )}
            </div>
          )}
        </Td>
        <Td className="text-right tabular-nums">
          <Input
            {...control('shares', 'w-20 text-right')}
            inputMode="numeric"
            value={values.shares}
            aria-label={t('pendingColQty')}
            onChange={(e) => onChange({ shares: e.target.value })}
          />
          {hint('shares')}
        </Td>
        <Td className="text-right tabular-nums">
          <Input
            {...control('price', 'w-28 text-right')}
            inputMode="decimal"
            value={values.price}
            aria-label={t('pendingColPrice')}
            onChange={(e) => onChange({ price: e.target.value })}
          />
          {hint('price')}
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
          {hint('fee')}
          {feeIsDerived(row, values) && (
            <div data-auto-fee aria-hidden="true" title={t('pendingFeeAutoHint')} className="text-xs text-muted-foreground">
              {t('pendingFeeAuto')}
            </div>
          )}
        </Td>
        <Td>
          {values.side === 'sell' && (
            <BucketSelect
              aria-label={t('fillBucket')}
              aria-describedby={bucketAsked ? bucketNeedsId : undefined}
              invalid={bucketAsked}
              value={bucket}
              held={row.heldBuckets}
              onChange={onBucketChange}
            />
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
          <div className="flex flex-col gap-1 sm:flex-row sm:gap-2">
            <Button variant="primary" busy={busy} onClick={onConfirm} aria-describedby={needsInput ? needsId : undefined}>
              {t('pendingConfirm')}
            </Button>
            <Button variant="danger" disabled={busy} onClick={onReject}>
              {t('pendingReject')}
            </Button>
          </div>
        </Td>
      </tr>
      {needsInput && (
        <tr data-needs-input>
          <Td colSpan={COLUMNS}>
            <div id={needsId} className="sticky left-0 w-fit max-w-[80vw] text-xs text-warning">
              {issues.length > 0 && <div data-needs-line="fields">{needsMsg}</div>}
              {dateLate && <div data-needs-line="date">{t('pendingDateAfterToday')}</div>}
              {bucketAsked && (
                <div id={bucketNeedsId} data-needs-line="bucket">
                  {t('pendingNeedsBucket')}
                </div>
              )}
            </div>
          </Td>
        </tr>
      )}
    </>
  );
}
