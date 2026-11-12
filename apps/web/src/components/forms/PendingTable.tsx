import { useState } from 'react';
import { ApiError, api, usdOrNull, type PendingFillDto } from '../../api';
import { useT } from '../../i18n';
import { pendingIssue } from '../../viewmodels';
import { isoDate, priceUsd } from '../../format';
import { useAsync } from '../hooks';
import { Button, EmptyNote, Input, TableWrap, Td, Th } from '../ui';

interface Overrides {
  shares: string;
  price: string;
  filledOn: string;
}

const EMPTY: Overrides = { shares: '', price: '', filledOn: '' };

// Unrecognized screenshot fills. Confirm accepts optional overrides
// {shares?, price?, filledOn?}; pendingIssue() highlights the field the row is
// missing. A 409 on confirm is either ticker-mismatch (integrity guard: the
// pending row's ticker ≠ the run's ticker — the untouched row stays visible
// for rejection) or the row was already handled elsewhere.
export function PendingTable({ runId }: { runId?: number }) {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => api.listPending(), []);
  const [overrides, setOverrides] = useState<Record<number, Overrides>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const visible = (data ?? []).filter((r) => runId === undefined || r.runId === runId);

  const setOverride = (id: number, field: keyof Overrides, value: string) =>
    setOverrides((prev) => ({ ...prev, [id]: { ...EMPTY, ...prev[id], [field]: value } }));

  const confirm = async (r: PendingFillDto) => {
    const o = overrides[r.id] ?? EMPTY;
    const body: { shares?: number; price?: string; filledOn?: string } = {};
    if (o.shares !== '') {
      if (!Number.isInteger(Number(o.shares)) || Number(o.shares) <= 0) throw new Error(t('pendingInvalidOverride'));
      body.shares = Number(o.shares);
    }
    if (o.price !== '') {
      const price = usdOrNull(o.price);
      if (price === null) throw new Error(t('pendingInvalidOverride'));
      body.price = price;
    }
    if (o.filledOn !== '') body.filledOn = o.filledOn;
    await api.confirmPending(r.id, Object.keys(body).length > 0 ? body : undefined);
  };

  const act = async (r: PendingFillDto, action: 'confirm' | 'reject') => {
    setBusyId(r.id);
    setActionError(null);
    try {
      if (action === 'confirm') await confirm(r);
      else await api.rejectPending(r.id);
      await reload();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ticker-mismatch') {
        // The row is untouched — do NOT reload; it must stay visible so the
        // user can reject it.
        setActionError(t('pendingTickerMismatch'));
      } else if (err instanceof ApiError && err.status === 409) {
        setActionError(t('pendingAlreadyHandled'));
        await reload();
      } else {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-destructive">{error}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
      {visible.length === 0 ? (
        <EmptyNote>{t('pendingEmpty')}</EmptyNote>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>{t('pendingColDate')}</Th>
              <Th>{t('pendingColTicker')}</Th>
              <Th>{t('pendingColSide')}</Th>
              <Th className="text-right">{t('pendingColQty')}</Th>
              <Th className="text-right">{t('pendingColPrice')}</Th>
              <Th>{t('pendingColDetected')}</Th>
              <Th>{t('pendingColActions')}</Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const issue = pendingIssue(r);
              const o = overrides[r.id] ?? EMPTY;
              const bad = (f: keyof Overrides) => (issue.field === f ? 'border-warning' : '');
              return (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap tabular-nums">
                    <Input
                      type="date"
                      className={`w-36 ${bad('filledOn')}`}
                      value={o.filledOn}
                      aria-label={t('pendingColDate')}
                      onChange={(e) => setOverride(r.id, 'filledOn', e.target.value)}
                    />
                  </Td>
                  <Td className="font-medium">{r.ticker || '?'}</Td>
                  <Td>{r.side === 'buy' || r.side === 'sell' ? t(r.side === 'buy' ? 'orderSideBuy' : 'orderSideSell') : '?'}</Td>
                  <Td className="text-right tabular-nums">
                    {r.shares > 0 ? r.shares : '?'}
                    <Input
                      className={`mt-1 w-24 ${bad('shares')}`}
                      placeholder={t('pendingQtyOverride')}
                      inputMode="numeric"
                      value={o.shares}
                      onChange={(e) => setOverride(r.id, 'shares', e.target.value)}
                    />
                  </Td>
                  <Td className="text-right tabular-nums">
                    {priceUsd(r.price)}
                    <Input
                      className={`mt-1 w-24 ${bad('price')}`}
                      placeholder={t('pendingPriceOverride')}
                      inputMode="decimal"
                      value={o.price}
                      onChange={(e) => setOverride(r.id, 'price', e.target.value)}
                    />
                  </Td>
                  <Td className="whitespace-nowrap text-muted-foreground tabular-nums">{isoDate(r.createdAt)}</Td>
                  <Td>
                    {issue.field !== null && (
                      <div className="mb-1 max-w-48 text-xs text-warning">{t('pendingNeedsOverride')}</div>
                    )}
                    <div className="flex gap-2">
                      <Button variant="primary" busy={busyId === r.id} onClick={() => void act(r, 'confirm')}>
                        {t('pendingConfirm')}
                      </Button>
                      <Button variant="danger" disabled={busyId === r.id} onClick={() => void act(r, 'reject')}>
                        {t('pendingReject')}
                      </Button>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
