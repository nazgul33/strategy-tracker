import { useState } from 'react';
import { ApiError, api, usdFeeOrNull, usdOrNull, usdToCents, type PendingFillDto, type PendingOverrides } from '../../api';
import { useT } from '../../i18n';
import { pendingEdits, type RowValues } from '../../viewmodels';
import { useAsync } from '../hooks';
import { EmptyNote, TableWrap, Th } from '../ui';
import { PendingRow, initialRowValues } from './PendingRow';

// Unrecognized screenshot fills. Every field is one control pre-filled with what
// vision detected; confirm sends only the fields that differ from that
// (pendingEdits), so an untouched confirm posts no overrides. A 409 on confirm is
// either ticker-mismatch (integrity guard: the pending row's ticker ≠ the run's
// ticker — the untouched row stays visible for rejection) or the row was
// already handled elsewhere.
export function PendingTable({ runId }: { runId?: number }) {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => api.listPending(), []);
  const [edited, setEdited] = useState<Record<number, RowValues>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const visible = (data ?? []).filter((r) => runId === undefined || r.runId === runId);

  const valuesFor = (r: PendingFillDto) => edited[r.id] ?? initialRowValues(r);
  const patchValues = (r: PendingFillDto, patch: Partial<RowValues>) =>
    setEdited((prev) => ({ ...prev, [r.id]: { ...(prev[r.id] ?? initialRowValues(r)), ...patch } }));

  const confirm = async (r: PendingFillDto) => {
    const v = valuesFor(r);
    const invalid = () => new Error(t('pendingInvalidOverride'));
    const body: PendingOverrides = {};
    for (const field of pendingEdits(r, v)) {
      if (field === 'side') {
        if (v.side !== 'buy' && v.side !== 'sell') throw invalid();
        body.side = v.side;
      } else if (field === 'shares') {
        const n = Number(v.shares);
        if (!Number.isInteger(n) || n <= 0) throw invalid();
        body.shares = n;
      } else if (field === 'price') {
        const price = usdOrNull(v.price);
        if (price === null) throw invalid();
        body.price = price;
      } else if (field === 'filledOn') {
        if (v.filledOn.trim() === '') throw invalid();
        body.filledOn = v.filledOn;
      } else if (v.fee.trim() === '') {
        body.feeCents = null;
      } else {
        const fee = usdFeeOrNull(v.fee);
        const cents = fee === null ? null : usdToCents(fee);
        if (cents === null) throw invalid();
        body.feeCents = cents;
      }
    }
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
              <Th className="text-right">{t('pendingColFee')}</Th>
              <Th />
              <Th>{t('pendingColDetected')}</Th>
              <Th>{t('pendingColActions')}</Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <PendingRow
                key={r.id}
                row={r}
                values={valuesFor(r)}
                onChange={(patch) => patchValues(r, patch)}
                onOpenSideBySide={() => undefined}
                onConfirm={() => void act(r, 'confirm')}
                onReject={() => void act(r, 'reject')}
                busy={busyId === r.id}
              />
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
