import { useState } from 'react';
import { ApiError, api, type CorrectionDto } from '../../api';
import { useT } from '../../i18n';
import { centsUsd, isoDate, priceUsd } from '../../format';
import { useAsync } from '../hooks';
import { Button, Card, SectionTitle, TableWrap, Td, Th } from '../ui';

// Open fill corrections proposed from later screenshots (booked → proposed
// price/fee). Renders nothing while the (run-filtered) list is empty and the
// load succeeded (a failed load shows its error), so a host can mount it
// unconditionally. `framed` wraps the section in its own Card
// (the Pending page); the run tab is already inside a Card.
// Apply is hidden for stale rows (the booked fill changed since the screenshot)
// — the only way out is Dismiss. A 409 correction-stale marks the row stale
// locally; correction-not-open means it was handled elsewhere.
export function CorrectionList({
  runId,
  onChanged,
  framed = false,
}: {
  runId?: number;
  onChanged?: () => void;
  framed?: boolean;
}) {
  const t = useT();
  const { data, error, reload } = useAsync(() => api.listCorrections(), []);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [staleIds, setStaleIds] = useState<ReadonlySet<number>>(new Set());

  const visible = (data ?? []).filter((r) => runId === undefined || r.runId === runId);

  const act = async (r: CorrectionDto, action: 'apply' | 'dismiss') => {
    setBusyId(r.id);
    setActionError(null);
    try {
      if (action === 'apply') await api.applyCorrection(r.id);
      else await api.dismissCorrection(r.id);
      await reload();
      onChanged?.();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'correction-stale') {
        setStaleIds((prev) => new Set(prev).add(r.id));
        await reload();
      } else if (err instanceof ApiError && err.status === 409) {
        setActionError(t('correctionAlreadyHandled'));
        await reload();
        onChanged?.();
      } else if (err instanceof ApiError) {
        // Same rule as FillDialog: known fillErr.* codes read localized, the
        // rest fall back to the raw server code (ApiError.message).
        const key = `fillErr.${err.code}`;
        const msg = t(key);
        setActionError(msg === key ? err.message : msg);
      } else {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusyId(null);
    }
  };

  if (visible.length === 0 && !actionError && !error) return null;

  const body = (
    <div className="space-y-3">
      <SectionTitle>{t('correctionsTitle')}</SectionTitle>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
      {visible.length > 0 && (
        <TableWrap>
          <thead>
            <tr>
              <Th>{t('tabFills')}</Th>
              <Th>{t('pendingColTicker')}</Th>
              <Th>{t('pendingColSide')}</Th>
              <Th className="text-right">{t('pendingColQty')}</Th>
              <Th>{t('pendingColDate')}</Th>
              <Th className="text-right">{t('pendingColPrice')}</Th>
              <Th className="text-right">{t('pendingColFee')}</Th>
              <Th>{t('pendingColActions')}</Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const stale = r.stale || staleIds.has(r.id);
              const feeChanged = r.proposedFee !== null && r.proposedFee !== r.bookedFee;
              return (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap font-medium">{t('correctionFill', { id: r.fillId })}</Td>
                  <Td className="font-medium">{r.ticker}</Td>
                  <Td>{t(r.side === 'buy' ? 'orderSideBuy' : 'orderSideSell')}</Td>
                  <Td className="text-right tabular-nums">{r.bookedShares}</Td>
                  <Td className="whitespace-nowrap tabular-nums">{isoDate(r.bookedFilledOn)}</Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">
                    {priceUsd(r.bookedPrice)} → {priceUsd(r.proposedPrice)}
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">
                    {centsUsd(r.bookedFee)}
                    {feeChanged && ` → ${centsUsd(r.proposedFee)}`}
                  </Td>
                  <Td>
                    {stale && <div className="mb-1 max-w-48 text-xs text-warning">{t('correctionStale')}</div>}
                    <div className="flex gap-2">
                      {!stale && (
                        <Button variant="primary" busy={busyId === r.id} onClick={() => void act(r, 'apply')}>
                          {t('correctionApply')}
                        </Button>
                      )}
                      <Button variant="danger" disabled={busyId === r.id} onClick={() => void act(r, 'dismiss')}>
                        {t('correctionDismiss')}
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
  return framed ? <Card>{body}</Card> : body;
}
