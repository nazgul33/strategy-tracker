import { useState, type FormEvent } from 'react';
import { feeCents, parseUsd } from '@st/core/money';
import { api, usdFeeOrNull, usdOrNull, type ManualFillInput } from '../../api';
import { useT } from '../../i18n';
import { centsToUsdText, todayIso } from '../../format';
import { Button, Field, Input } from '../ui';

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

// Manual fill capture — the exact fields POST /runs/:id/fills accepts:
// side, shares, price, fee (optional), filledOn. The ticker is the run's own
// (server-stamped), not an input field. No bucket index.
export function ManualCaptureForm({
  runId,
  costPpm,
  onAdded,
}: {
  runId: number;
  costPpm?: number;
  onAdded?: () => void;
}) {
  const t = useT();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [shares, setShares] = useState('');
  const [price, setPrice] = useState('');
  const [fee, setFee] = useState('');
  const [feeTouched, setFeeTouched] = useState(false);
  const [filledOn, setFilledOn] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
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
    const input: ManualFillInput = {
      side,
      shares: Number(shares),
      price: priceUsd,
      fee: feeUsd ?? undefined,
      filledOn,
    };
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api.addManualFill(runId, input);
      setDone(t('manualSubmitted'));
      setShares('');
      setPrice('');
      setFee('');
      setFeeTouched(false);
      onAdded?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('manualSide')}>
          <select
            value={side}
            onChange={(e) => setSide(e.target.value as 'buy' | 'sell')}
            data-testid="manualSideSelect"
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="buy">{t('orderSideBuy')}</option>
            <option value="sell">{t('orderSideSell')}</option>
          </select>
        </Field>
        <Field label={t('manualQty')}>
          <Input
            data-testid="manualSharesInput"
            value={shares}
            onChange={(e) => {
              const v = e.target.value;
              setShares(v);
              if (!feeTouched) setFee(autoFeeUsd(v, price, costPpm));
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
              if (!feeTouched) setFee(autoFeeUsd(shares, v, costPpm));
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
            }}
            inputMode="decimal"
            placeholder="1.50"
          />
        </Field>
        <Field label={t('manualFilledOn')}>
          <Input type="date" data-testid="manualDateInput" value={filledOn} onChange={(e) => setFilledOn(e.target.value)} required />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" busy={busy}>
          {t('manualSubmit')}
        </Button>
        <Button type="button" onClick={() => setFilledOn(todayIso())}>
          {t('today')}
        </Button>
      </div>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {done && <p className="text-sm text-emerald-700 dark:text-emerald-300">{done}</p>}
    </form>
  );
}
