// "New run" dialog: mean-reversion params + optional opening positions (seed).
import { useState } from 'react';

import { api, usdOrNull, usdToCents } from '../../api';
import { useT } from '../../i18n';
import { Button, Field, Input } from '../ui';

interface SeedRow {
  shares: string;
  buyPrice: string;
  filledOn: string;
}

const EMPTY_ROW: SeedRow = { shares: '', buyPrice: '', filledOn: '' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TICKER_RE = /^[A-Za-z.]{1,10}$/;

export function CreateRunForm({
  onCreated,
  onCancel,
}: {
  onCreated: (id: number) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [pool, setPool] = useState('');
  const [costPpm, setCostPpm] = useState('200');
  const [bucketCount, setBucketCount] = useState('');
  const [seedCash, setSeedCash] = useState('');
  const [seedRows, setSeedRows] = useState<SeedRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<number | null>(null);

  const setRow = (i: number, patch: Partial<SeedRow>) =>
    setSeedRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = async () => {
    if (busy) return;
    setError(null);
    if (!TICKER_RE.test(ticker.trim())) {
      setError(t('runInvalidTicker'));
      return;
    }
    const poolCents = usdToCents(pool);
    if (poolCents === null || poolCents <= 0) {
      setError(t('runInvalidPool'));
      return;
    }
    if (!/^\d{1,7}$/.test(costPpm.trim())) {
      setError(t('runInvalidCostPpm'));
      return;
    }
    let bucketsN: number | undefined;
    if (bucketCount.trim() !== '') {
      bucketsN = Number(bucketCount);
      if (!Number.isInteger(bucketsN) || bucketsN < 2 || bucketsN > 20) {
        setError(t('runInvalidBucketCount'));
        return;
      }
    }
    let seed: { cashCents?: number; buckets?: { shares: number; buyPrice: string; filledOn: string }[] } | undefined;
    const rows = seedRows.filter((r) => r.shares !== '' || r.buyPrice !== '' || r.filledOn !== '');
    if (rows.length > 0 || seedCash.trim() !== '') {
      const buckets: { shares: number; buyPrice: string; filledOn: string }[] = [];
      for (const r of rows) {
        const shares = Number(r.shares);
        if (!Number.isInteger(shares) || shares <= 0) {
          setError(t('manualInvalidQty'));
          return;
        }
        const price = usdOrNull(r.buyPrice);
        if (price === null) {
          setError(t('manualInvalidPrice'));
          return;
        }
        if (!DATE_RE.test(r.filledOn)) {
          setError(t('manualInvalidDate'));
          return;
        }
        buckets.push({ shares, buyPrice: price, filledOn: r.filledOn });
      }
      let cashCents: number | undefined;
      if (seedCash.trim() !== '') {
        const parsed = usdToCents(seedCash);
        if (parsed === null) {
          setError(t('poolInvalidAmount'));
          return;
        }
        cashCents = parsed;
      }
      seed = cashCents === undefined ? { buckets } : { cashCents, buckets };
    }

    setBusy(true);
    try {
      const res = await api.createRun({
        name: name.trim() === '' ? ticker.trim().toUpperCase() : name.trim(),
        ticker: ticker.trim().toUpperCase(),
        costPpm: Number(costPpm),
        poolCents,
        bucketCount: bucketsN,
        seed,
      });
      setCreatedId(res.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (createdId !== null) {
    return (
      <div className="space-y-4">
        <div role="status" className="rounded border border-positive/40 bg-positive/10 px-3 py-2 text-sm text-positive">
          {t('runStarted', { id: createdId })}{' '}
          <a href={`#/runs/${createdId}`} className="font-medium underline" onClick={() => onCreated(createdId)}>
            #{createdId}
          </a>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>{t('cancel')}</Button>
          <Button variant="primary" onClick={() => onCreated(createdId)}>
            {t('actionBack')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error !== null && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('runName')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label={t('runTicker')}>
          <Input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="QQQ" />
        </Field>
        <Field label={t('runPoolCents')}>
          <Input value={pool} onChange={(e) => setPool(e.target.value)} inputMode="decimal" placeholder="10000" />
        </Field>
        <Field label={`${t('runCostPpm')} (ppm)`}>
          <Input value={costPpm} onChange={(e) => setCostPpm(e.target.value)} inputMode="numeric" />
        </Field>
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {t('runParamsOptional')} · {t('optional')}
        </summary>
        <div className="mt-3">
          <Field label={t('runBucketCount')}>
            <Input
              value={bucketCount}
              onChange={(e) => setBucketCount(e.target.value)}
              inputMode="numeric"
              placeholder="10"
              className="w-32"
            />
          </Field>
        </div>
      </details>

      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {t('seedTitle')} · {t('optional')}
        </summary>
        <div className="mt-3 space-y-3">
          <Field label={t('seedCash')}>
            <Input value={seedCash} onChange={(e) => setSeedCash(e.target.value)} inputMode="decimal" className="w-40" />
          </Field>
          {seedRows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                aria-label={t('seedShares')}
                className="w-20"
                inputMode="numeric"
                placeholder={t('seedShares')}
                value={r.shares}
                onChange={(e) => setRow(i, { shares: e.target.value })}
              />
              <Input
                aria-label={t('seedBuyPrice')}
                className="w-28"
                inputMode="decimal"
                placeholder={t('seedBuyPrice')}
                value={r.buyPrice}
                onChange={(e) => setRow(i, { buyPrice: e.target.value })}
              />
              <Input
                aria-label={t('seedFilledOn')}
                className="w-36"
                type="date"
                value={r.filledOn}
                onChange={(e) => setRow(i, { filledOn: e.target.value })}
              />
              <Button
                aria-label={t('seedRemoveRow')}
                variant="danger"
                onClick={() => setSeedRows((prev) => prev.filter((_, j) => j !== i))}
              >
                ✕
              </Button>
            </div>
          ))}
          <Button onClick={() => setSeedRows((prev) => [...prev, EMPTY_ROW])}>{t('seedAddRow')}</Button>
        </div>
      </details>

      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{t('cancel')}</Button>
        <Button variant="primary" busy={busy} onClick={() => void submit()}>
          {t('create')}
        </Button>
      </div>
    </div>
  );
}
