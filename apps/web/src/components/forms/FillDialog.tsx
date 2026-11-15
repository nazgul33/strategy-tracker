import { useState, type FormEvent } from 'react';
import { feeCents, parseUsd } from '@st/core/money';
import { api, ApiError, usdFeeOrNull, usdOrNull, type FillUpdatePayload, type ManualFillInput } from '../../api';
import { useT } from '../../i18n';
import { centsToUsdText, isoDate, priceInputValue, todayIso, usdTextToCents } from '../../format';
import type { FillDto } from '../../api.types';
import { RecalcResultModal, type RecalcResult } from '../RecalcSummary';
import { Button, Field, Input, Modal, Select } from '../ui';

// Fee text the server would book for these inputs (same feeCents half-up math
// as booking.ts), or '' when the run has no usable cost, price/shares are
// invalid, or the fee would not be accepted by the fee field.
export function autoFeeUsd(shares: string, price: string, costPpm: number | undefined): string {
  if (costPpm === undefined || !Number.isInteger(costPpm) || costPpm < 0) return '';
  const priceUsd = usdOrNull(price);
  if (priceUsd === null || !Number.isInteger(Number(shares)) || Number(shares) <= 0) return '';
  const text = centsToUsdText(feeCents(parseUsd(priceUsd), Number(shares), costPpm));
  return usdFeeOrNull(text) === null ? '' : text;
}

// Shared fill dialog (Modal): add mode posts a manual fill, modify mode (a
// `fill` prop) PUTs qty/price/fee/date — side stays locked because the server
// treats it as immutable. With `deletable`, the footer gains Delete →
// an in-dialog confirm step (the server only allows deleting a bucket's last
// fill; that error maps through fillErr.*).
export interface FillDialogProps {
  runId: number;
  costPpm?: number;
  /** When present the dialog edits this fill instead of adding a new one. */
  fill?: FillDto;
  /** Show the Delete step (fill is the bucket's last one). */
  deletable?: boolean;
  /** Fill lives in a closed bucket: edits re-book cash on a settled bucket. */
  bucketClosed?: boolean;
  initialSide?: 'buy' | 'sell';
  onClose: () => void;
  onSaved: () => void;
}

export function FillDialog({
  runId,
  costPpm,
  fill,
  deletable = false,
  bucketClosed = false,
  initialSide = 'buy',
  onClose,
  onSaved,
}: FillDialogProps) {
  const t = useT();
  const modify = fill !== undefined;
  const [side, setSide] = useState<'buy' | 'sell'>(fill ? fill.side : initialSide);
  const [shares, setShares] = useState(fill ? String(fill.shares) : '');
  const [price, setPrice] = useState(fill ? priceInputValue(fill.price) : '');
  const [fee, setFee] = useState(fill ? centsToUsdText(fill.fee) : '');
  const [filledOn, setFilledOn] = useState(fill ? isoDate(fill.filledOn) : todayIso());
  const [feeTouched, setFeeTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Recompute outcome of the last successful save/delete; while set, the
  // render swaps the form for the shared result popup (null = no result yet).
  const [doneResult, setDoneResult] = useState<RecalcResult | null>(null);

  const showFailure = (err: unknown) => {
    if (err instanceof ApiError) {
      const key = `fillErr.${err.code}`;
      const msg = t(key);
      setError(msg === key ? err.message : msg);
    } else {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const syncAutoFee = (nextShares: string, nextPrice: string) => {
    if (!feeTouched) setFee(autoFeeUsd(nextShares, nextPrice, costPpm));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    let payload: FillUpdatePayload | null = null;
    let input: ManualFillInput | null = null;
    if (fill) {
      // Client guards mirroring PUT /runs/:id/fills/:fillId (cents payloads).
      const priceCents = usdTextToCents(price);
      if (priceCents === null) {
        setError(t('manualInvalidPrice'));
        return;
      }
      if (!Number.isInteger(Number(shares)) || Number(shares) <= 0) {
        setError(t('manualInvalidQty'));
        return;
      }
      const feeCentsVal = fee.trim() === '' ? null : usdTextToCents(fee);
      if (fee.trim() !== '' && feeCentsVal === null) {
        setError(t('manualInvalidFee'));
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(filledOn)) {
        setError(t('manualInvalidDate'));
        return;
      }
      payload = { qty: Number(shares), priceCents, feeCents: feeCentsVal, filledOn };
    } else {
      // Client-side guards mirroring the server's checks (same messages as the API docs).
      const priceUsd = usdOrNull(price);
      if (priceUsd === null) {
        setError(t('manualInvalidPrice'));
        return;
      }
      if (!Number.isInteger(Number(shares)) || Number(shares) <= 0) {
        setError(t('manualInvalidQty'));
        return;
      }
      const feeUsd = usdFeeOrNull(fee);
      if (fee.trim() !== '' && feeUsd === null) {
        setError(t('manualInvalidFee'));
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(filledOn)) {
        setError(t('manualInvalidDate'));
        return;
      }
      input = { side, shares: Number(shares), price: priceUsd, fee: feeUsd ?? undefined, filledOn };
    }
    setBusy(true);
    try {
      let deltaCents: number | undefined;
      if (payload && fill) deltaCents = (await api.updateFill(runId, fill.id, payload)).deltaCents;
      else if (input) await api.addManualFill(runId, input);
      // A nonzero delta means the save re-booked cash on a closed bucket: keep
      // the dialog open on a success step so the number is actually seen.
      if (deltaCents !== undefined && deltaCents !== 0) setDoneResult({ deltaCents });
      else {
        onSaved();
        onClose();
      }
    } catch (err) {
      showFailure(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!fill || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.deleteFill(runId, fill.id);
      // Same contract as submit(): a booked adjustment gets its own step.
      if (res.deltaCents !== 0) setDoneResult({ deltaCents: res.deltaCents });
      else {
        onSaved();
        onClose();
      }
    } catch (err) {
      showFailure(err);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const errorLine = error !== null && (
    <p data-testid="error" className="text-sm text-red-600 dark:text-red-400">
      {error}
    </p>
  );

  // Closed buckets are settled: touching their fills re-books cash retroactively.
  const closedNote = bucketClosed && (
    <p className="rounded-md bg-warning/10 px-2 py-1.5 text-sm text-warning">{t('closedFillWarning')}</p>
  );

  // Save/delete booked a cash adjustment: the form is replaced by the shared
  // result popup; dismissing it (OK, ✕ or backdrop) acknowledges and notifies.
  if (doneResult !== null) {
    return (
      <RecalcResultModal
        result={doneResult}
        onClose={() => {
          onSaved();
          onClose();
        }}
      />
    );
  }

  if (confirming && fill) {
    return (
      <Modal title={t('dialog.delete')} onClose={onClose}>
        <p className="text-sm">{t('dialog.deleteWarning', { n: fill.shares })}</p>
        {closedNote}
        {errorLine}
        <div className="mt-3 flex items-center gap-3">
          <Button variant="danger" busy={busy} onClick={() => void remove()}>
            {t('dialog.deleteConfirm')}
          </Button>
          <Button onClick={() => setConfirming(false)}>{t('cancel')}</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={modify ? t('dialog.editFill') : t('dialog.addFill')} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <Field label={t('manualSide')}>
          <Select
            data-testid="manualSideSelect"
            value={side}
            disabled={modify}
            onChange={(e) => setSide(e.target.value as 'buy' | 'sell')}
          >
            <option value="buy">{t('orderSideBuy')}</option>
            <option value="sell">{t('orderSideSell')}</option>
          </Select>
        </Field>
        <Field label={t('manualQty')}>
          <Input
            data-testid="manualSharesInput"
            value={shares}
            onChange={(e) => {
              const v = e.target.value;
              setShares(v);
              syncAutoFee(v, price);
            }}
            inputMode="numeric"
            required
          />
        </Field>
        <Field label={t('manualPrice')}>
          <Input
            data-testid="manualPriceInput"
            value={price}
            onChange={(e) => {
              const v = e.target.value;
              setPrice(v);
              syncAutoFee(shares, v);
            }}
            inputMode="decimal"
            placeholder="349.99"
            required
          />
        </Field>
        <Field label={`${t('manualFee')} (${t('optional')})`}>
          <Input
            data-testid="manualFeeInput"
            value={fee}
            onChange={(e) => {
              const v = e.target.value;
              setFee(v);
              setFeeTouched(v.trim() !== '');
              if (v.trim() === '') syncAutoFee(shares, price);
            }}
            inputMode="decimal"
            placeholder="1.50"
          />
        </Field>
        <Field label={t('manualFilledOn')}>
          <Input
            type="date"
            data-testid="manualDateInput"
            value={filledOn}
            onChange={(e) => setFilledOn(e.target.value)}
            required
          />
        </Field>
        {closedNote}
        {errorLine}
        <div className="flex items-center gap-3">
          <Button onClick={onClose}>{t('cancel')}</Button>
          {modify && deletable && (
            <Button
              data-testid="fillDeleteBtn"
              onClick={() => {
                setError(null);
                setConfirming(true);
              }}
            >
              {t('dialog.delete')}
            </Button>
          )}
          <Button type="submit" variant="primary" busy={busy}>
            {modify ? t('dialog.save') : t('dialog.add')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
