// Pending tab of a VR run: fills read from screenshots that wait for the owner's decision.
// Edit, Confirm and Reject per row, and Confirm all above the table.
import { useState } from 'react';
import { ApiError, type ApiErrorCode } from '../../api';
import { vrApi } from '../../api.vr';
import type { VrConfirmAllResult, VrPendingDto } from '../../api.vr.types';
import { errorText } from '../../errortext';
import { centsUsd, isoDate, priceUsd } from '../../format';
import { useT } from '../../i18n';
import { ScreenshotLink } from '../ScreenshotLink';
import { useAsync } from '../hooks';
import { Badge, Button, EmptyNote, ErrorNote, Spinner, TableWrap, Td, Th } from '../ui';
import type { VrPanelProps } from './VrFillsPanel';
import { VrPendingDialog } from './VrPendingDialog';
import { VrPanelState } from './VrPanelState';

const NUM = 'text-right tabular-nums';

type Busy = number | 'all' | null;

export function VrPendingPanel({ runId, costPpm, onChanged }: VrPanelProps) {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => vrApi.listPending(runId), [runId]);
  const [editing, setEditing] = useState<VrPendingDto | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  // `rows` is the list as it was before Confirm all: the server names a refused row by id only.
  const [summary, setSummary] = useState<{ result: VrConfirmAllResult; rows: VrPendingDto[] } | null>(null);
  const [allError, setAllError] = useState<string | null>(null);

  const clearNotes = () => {
    setSummary(null);
    setAllError(null);
  };

  const decide = async (row: VrPendingDto, action: 'confirm' | 'reject') => {
    setBusy(row.id);
    clearNotes();
    setRowErrors((prev) => ({ ...prev, [row.id]: '' }));
    try {
      if (action === 'confirm') await vrApi.confirmPending(runId, row.id);
      else await vrApi.rejectPending(runId, row.id);
      await reload();
      onChanged();
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [row.id]: errorText(err, t, 'vrErr') }));
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
      await reload();
      onChanged();
    } catch (err) {
      setAllError(errorText(err, t, 'vrErr'));
    } finally {
      setBusy(null);
    }
  };

  const saved = () => {
    if (editing) setRowErrors((prev) => ({ ...prev, [editing.id]: '' }));
    void reload();
    onChanged();
  };

  const codeText = (code: string): string =>
    errorText(new ApiError(code === 'vr-not-pending' ? 409 : 422, code as ApiErrorCode), t, 'vrErr');

  const fillText = (id: number, rows: VrPendingDto[]): string => {
    const row = rows.find((r) => r.id === id);
    if (!row) return `#${id}`;
    return t('vr.pendingFillLine', {
      side: t(row.side === 'buy' ? 'orderSideBuy' : 'orderSideSell'),
      shares: row.shares,
      price: priceUsd(row.price),
      date: isoDate(row.filledOn),
    });
  };

  const summaryBox = summary && (
    <div role="status" data-testid="vrConfirmAllSummary" className="mb-3 rounded-md bg-muted px-2 py-1.5 text-sm">
      <p data-testid="vrConfirmAllBooked">{t('vr.confirmAllBooked', { n: summary.result.confirmed })}</p>
      {summary.result.refused.length > 0 && (
        <>
          <p>{t('vr.confirmAllRefusedHead', { n: summary.result.refused.length })}</p>
          <ul data-testid="vrConfirmAllRefused">
            {summary.result.refused.map((r) => (
              <li key={r.id}>
                {t('vr.confirmAllRefusedRow', { fill: fillText(r.id, summary.rows), reason: codeText(r.error) })}
              </li>
            ))}
          </ul>
        </>
      )}
      <p data-testid="vrConfirmAllLeftDuplicates">
        {t('vr.confirmAllLeftDuplicates', { n: summary.result.skippedDuplicates })}
      </p>
      <p data-testid="vrConfirmAllLeftUndated">{t('vr.confirmAllLeftUndated', { n: summary.result.skippedUndated })}</p>
    </div>
  );

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
        {allError !== null && (
          <div className="mb-3">
            <ErrorNote message={allError} />
          </div>
        )}
        {summaryBox}
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
                  <Td className={NUM}>{priceUsd(r.price)}</Td>
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
                          <Badge tone="warning">{t('vr.pendingPossibleDuplicate', { price: priceUsd(r.dupPrice) })}</Badge>
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
                      <p data-testid={`vrPendingError-${r.id}`} className="text-xs text-destructive">
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
        <VrPendingDialog runId={runId} costPpm={costPpm} row={editing} onClose={() => setEditing(null)} onSaved={saved} />
      )}
    </div>
  );
}
