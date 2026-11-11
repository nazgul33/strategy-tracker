import { useState, type FormEvent } from 'react';
import { api, usdFeeOrNull, usdOrNull, type ManualFillInput } from '../../api';
import { useT } from '../../i18n';
import { todayIso } from '../../format';
import { Button, Field, Input } from '../ui';

// Manual fill capture — the exact fields POST /runs/:id/manual-fills accepts:
// side, ticker, shares, price, fee (optional), filledOn. No bucket index.
export function ManualCaptureForm({ runId, onAdded }: { runId: number; onAdded?: () => void }) {
  const t = useT();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [ticker, setTicker] = useState('');
  const [shares, setShares] = useState('');
  const [price, setPrice] = useState('');
  const [fee, setFee] = useState('');
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
      ticker: ticker.trim().toUpperCase(),
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
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="buy">{t('orderSideBuy')}</option>
            <option value="sell">{t('orderSideSell')}</option>
          </select>
        </Field>
        <Field label={t('manualTicker')}>
          <Input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="AAPL" required />
        </Field>
        <Field label={t('manualQty')}>
          <Input value={shares} onChange={(e) => setShares(e.target.value)} inputMode="numeric" required />
        </Field>
        <Field label={t('manualPrice')}>
          <Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="349.99" required />
        </Field>
        <Field label={`${t('manualFee')} (${t('optional')})`}>
          <Input value={fee} onChange={(e) => setFee(e.target.value)} inputMode="decimal" placeholder="1.50" />
        </Field>
        <Field label={t('manualFilledOn')}>
          <Input type="date" value={filledOn} onChange={(e) => setFilledOn(e.target.value)} required />
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
