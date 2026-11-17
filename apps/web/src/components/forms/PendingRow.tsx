import { api, type PendingFillDto } from '../../api';
import { useT } from '../../i18n';
import { isoDate, priceInputValue } from '../../format';
import { pendingIssue, type RowValues } from '../../viewmodels';
import { Button, Input, Select, Td } from '../ui';

// Myriadths → an input value: at least two decimals, more only when the price
// really has them, so an untouched field never reads as an edit.
function priceField(myriadths: string | null | undefined): string {
  if (!myriadths) return '';
  return priceInputValue(myriadths).replace(/(\.\d{2}\d*?)0*$/, '$1');
}

function feeField(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** What the row's controls start with: what vision detected, the fee falling back to the derived one. */
export function initialRowValues(row: PendingFillDto): RowValues {
  const d = row.detected;
  const shares = d ? d.shares : row.shares;
  return {
    filledOn: (d ? d.filledOn : row.filledOn) ?? '',
    side: (d ? d.side : row.side) ?? '',
    shares: shares ? String(shares) : '',
    price: priceField(d ? d.price : row.price),
    fee: feeField((d ? d.fee : row.fee) ?? row.autoFeeCents),
  };
}

interface PendingRowProps {
  row: PendingFillDto;
  values: RowValues;
  onChange: (patch: Partial<RowValues>) => void;
  onOpenSideBySide: () => void;
  onConfirm: () => void;
  onReject: () => void;
  busy: boolean;
}

export function PendingRow({ row, values, onChange, onOpenSideBySide, onConfirm, onReject, busy }: PendingRowProps) {
  const t = useT();
  const issue = pendingIssue(row).field;
  // Flag a field the row is missing until the operator has filled it in.
  const missing = (f: keyof RowValues) => (issue === f && values[f] === '' ? 'border-warning' : '');
  const needsInput = issue === 'ticker' || (issue !== null && values[issue] === '');
  const captureId = row.hasImage ? row.captureId : null;
  return (
    <tr>
      <Td className="whitespace-nowrap tabular-nums">
        <Input
          type="date"
          className={`w-36 ${missing('filledOn')}`}
          value={values.filledOn}
          aria-label={t('pendingColDate')}
          onChange={(e) => onChange({ filledOn: e.target.value })}
        />
      </Td>
      <Td className="font-medium">{row.ticker || '?'}</Td>
      <Td>
        <Select
          className={missing('side')}
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
          className={`w-20 text-right ${missing('shares')}`}
          inputMode="numeric"
          value={values.shares}
          aria-label={t('pendingColQty')}
          onChange={(e) => onChange({ shares: e.target.value })}
        />
      </Td>
      <Td className="text-right tabular-nums">
        <Input
          className={`w-28 text-right ${missing('price')}`}
          inputMode="decimal"
          value={values.price}
          aria-label={t('pendingColPrice')}
          onChange={(e) => onChange({ price: e.target.value })}
        />
      </Td>
      <Td className="text-right tabular-nums">
        <Input
          className="w-20 text-right"
          inputMode="decimal"
          value={values.fee}
          aria-label={t('pendingColFee')}
          onChange={(e) => onChange({ fee: e.target.value })}
        />
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
      <Td>
        {needsInput && <div className="mb-1 max-w-48 text-xs text-warning">{t(issue === 'ticker' ? 'pendingNeedsTicker' : 'pendingNeedsOverride')}</div>}
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
