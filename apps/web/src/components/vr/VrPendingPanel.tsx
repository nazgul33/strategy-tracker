// Pending tab of a VR run: fills read from screenshots that wait for the owner's decision.
// Edit, Confirm and Reject per row, and Confirm all above the table.
import { useState } from 'react';
import { vrApi } from '../../api.vr';
import type { VrConfirmAllResult, VrPendingDto } from '../../api.vr.types';
import { errorText, isRefusal } from '../../errortext';
import { centsUsd, isoDate } from '../../format';
import { useT } from '../../i18n';
import { ScreenshotLink } from '../ScreenshotLink';
import { useAsync } from '../hooks';
import { Badge, Button, EmptyNote, ErrorNote, Spinner, TableWrap, Td, Th } from '../ui';
import { VrConfirmAllSummary } from './VrConfirmAllSummary';
import type { VrPanelProps } from './VrFillsPanel';
import { VrPendingDialog } from './VrPendingDialog';
import { VrPanelState } from './VrPanelState';
import { readPriceUsd } from './vrText';

const NUM = 'text-right tabular-nums';

// One action at a time; 'list' is the re-read that follows an edit.
type Busy = number | 'all' | 'list' | null;

export function VrPendingPanel({ runId, costPpm, onChanged }: VrPanelProps) {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => vrApi.listPending(runId), [runId]);
  const [editing, setEditing] = useState<VrPendingDto | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [summary, setSummary] = useState<{ result: VrConfirmAllResult; rows: VrPendingDto[] } | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);

  const clearNotes = () => {
    setSummary(null);
    setPanelError(null);
  };

  // Re-reads the list, then lets the run page re-read its books.
  const refresh = async () => {
    await reload();
    onChanged();
  };

  const decide = async (row: VrPendingDto, action: 'confirm' | 'reject') => {
    setBusy(row.id);
    clearNotes();
    setRowErrors((prev) => ({ ...prev, [row.id]: '' }));
    try {
      if (action === 'confirm') await vrApi.confirmPending(runId, row.id);
      else await vrApi.rejectPending(runId, row.id);
      await refresh();
    } catch (err) {
      if (isRefusal(err)) {
        setRowErrors((prev) => ({ ...prev, [row.id]: errorText(err, t, 'vrErr') }));
      } else {
        // The row may be gone (decided elsewhere) or the answer may have been lost: say it here, then look again.
        setPanelError(errorText(err, t, 'vrErr'));
        await refresh();
      }
    } finally {
      setBusy(null);
    }
  };

  const confirmAll = async () => {
    const snapshot = data ?? [];
    setBusy('all');
    setRowErrors({});
    clearNotes();
    try {
      const result = await vrApi.confirmAllPending(runId);
      setSummary({ result, rows: snapshot });
      await refresh();
    } catch (err) {
      // The server books row by row, so some may have been booked before it failed.
      setPanelError(`${errorText(err, t, 'vrErr')} ${t('vr.confirmAllMaybeBooked')}`);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  // After an edit is saved, or after the dialog found its row already decided: stay busy until the list is back.
  const settle = async () => {
    setBusy('list');
    clearNotes();
    try {
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const saved = () => {
    if (editing) setRowErrors((prev) => ({ ...prev, [editing.id]: '' }));
    void settle();
  };

  const body = () => {
    if (loading) return <Spinner />;
    if (error) return <VrPanelState error={error} onRetry={() => void reload()} />;
    const rows = data ?? [];
    return (
      <>
        <div className="mb-3 flex justify-end">
          <Button
            variant="primary"
            data-testid="vrPendingConfirmAll"
            busy={busy === 'all'}
            disabled={busy !== null || rows.length === 0}
            onClick={() => void confirmAll()}
          >
            {t('vr.pendingConfirmAll')}
          </Button>
        </div>
        {panelError !== null && (
          <div data-testid="vrPendingPanelError" className="mb-3">
            <ErrorNote message={panelError} />
          </div>
        )}
        {summary && <VrConfirmAllSummary result={summary.result} rows={summary.rows} />}
        {rows.length === 0 ? (
          <EmptyNote>{t('vr.pendingEmpty')}</EmptyNote>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('vr.colDate')}</Th>
                <Th>{t('fillColSide')}</Th>
                <Th className="text-right">{t('vr.colShares')}</Th>
                <Th className="text-right">{t('fillColPrice')}</Th>
                <Th className="text-right">{t('vr.colOrderPrice')}</Th>
                <Th className="text-right">{t('fillColFee')}</Th>
                <Th>{t('pendingColScreenshot')}</Th>
                <Th>{t('fillColNote')}</Th>
                <Th className="text-right">{t('fillColActions')}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap tabular-nums">{isoDate(r.filledOn)}</Td>
                  <Td>
                    <Badge tone={r.side === 'buy' ? 'info' : 'primary'}>
                      {t(r.side === 'buy' ? 'orderSideBuy' : 'orderSideSell')}
                    </Badge>
                  </Td>
                  <Td className={NUM}>{r.shares}</Td>
                  <Td className={NUM}>{readPriceUsd(r.price)}</Td>
                  <Td className={NUM}>{r.orderPrice === null ? '' : readPriceUsd(r.orderPrice)}</Td>
                  <Td className={NUM}>{r.fee === null ? t('pendingFeeAuto') : centsUsd(r.fee)}</Td>
                  <Td>
                    {r.hasImage ? (
                      <ScreenshotLink captureId={r.captureId} imgClassName="h-10 w-auto rounded border border-border" />
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {!r.dateRead && (
                        <span data-testid={`vrPendingNoDate-${r.id}`}>
                          <Badge tone="warning">{t('vr.pendingNoDate')}</Badge>
                        </span>
                      )}
                      {r.dateAfterToday && (
                        <span data-testid={`vrPendingFuture-${r.id}`}>
                          <Badge tone="danger">{t('vr.pendingAfterToday')}</Badge>
                        </span>
                      )}
                      {r.dupPrice !== null && (
                        <span data-testid={`vrPendingDup-${r.id}`}>
                          <Badge tone="warning">{t('vr.pendingPossibleDuplicate', { price: readPriceUsd(r.dupPrice) })}</Badge>
                        </span>
                      )}
                    </div>
                  </Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button data-testid={`vrPendingEdit-${r.id}`} disabled={busy !== null} onClick={() => setEditing(r)}>
                        {t('fillEdit')}
                      </Button>
                      <Button
                        variant="primary"
                        data-testid={`vrPendingConfirm-${r.id}`}
                        busy={busy === r.id}
                        disabled={r.dateAfterToday || busy !== null}
                        onClick={() => void decide(r, 'confirm')}
                      >
                        {t('pendingConfirm')}
                      </Button>
                      <Button data-testid={`vrPendingReject-${r.id}`} disabled={busy !== null} onClick={() => void decide(r, 'reject')}>
                        {t('pendingReject')}
                      </Button>
                    </div>
                    {r.dateAfterToday && (
                      <p data-testid={`vrPendingFutureHint-${r.id}`} className="text-xs text-warning">
                        {t('vr.pendingEditDateHint')}
                      </p>
                    )}
                    {rowErrors[r.id] && (
                      <p role="alert" data-testid={`vrPendingError-${r.id}`} className="text-xs text-destructive">
                        {rowErrors[r.id]}
                      </p>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </>
    );
  };

  return (
    <div data-testid="vrPendingPanel" data-run-id={runId}>
      {body()}
      {editing && (
        <VrPendingDialog
          runId={runId}
          costPpm={costPpm}
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={saved}
          onStale={() => void settle()}
        />
      )}
    </div>
  );
}
