// Tab panels for the run detail page: each one owns its own fetch so tab
// switches stay cheap and a panel-level failure never blanks the whole page.
import { useState } from 'react';

import { api, type FillDto } from '../api';
import { useAsync } from '../components/hooks';
import { FillTable } from './FillTable';
import { FillDialog } from './forms/FillDialog';
import { NoticeList } from './NoticeList';
import { OrderTable } from './OrderTable';
import { Button, ErrorNote, Input, Modal, Select, Spinner } from './ui';
import { useT } from '../i18n';
import { CANCEL_REASONS, enumLabelKey } from '../viewmodels';

function PanelState({ error, onRetry }: { error: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="flex items-center gap-3">
      <ErrorNote message={error} />
      <Button onClick={onRetry}>{t('retry')}</Button>
    </div>
  );
}

export function OrdersPanel({ runId }: { runId: number }) {
  const t = useT();
  const [date, setDate] = useState('');
  const { data, error, loading, reload } = useAsync(() => api.listOrders(runId, date || undefined), [runId, date]);
  const [cancelId, setCancelId] = useState<number | null>(null);
  const [reason, setReason] = useState<string>(CANCEL_REASONS[0]);
  const [busy, setBusy] = useState(false);
  const [cancelError, setCancelError] = useState(false);

  const submitCancel = async () => {
    if (cancelId === null) return;
    setBusy(true);
    setCancelError(false);
    try {
      await api.cancelOrder(runId, cancelId, reason);
      setCancelId(null);
      await reload();
    } catch {
      setCancelError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t('orderFilterDate')}
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        {date !== '' && (
          <Button onClick={() => setDate('')}>{t('all')}</Button>
        )}
      </div>
      {loading ? (
        <Spinner />
      ) : error ? (
        <PanelState error={error} onRetry={() => void reload()} />
      ) : (
        <OrderTable orders={data ?? []} onCancel={setCancelId} />
      )}
      {cancelId !== null && (
        <Modal title={t('cancelOrder')} onClose={() => setCancelId(null)}>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('orderColReason')}
            <Select value={reason} onChange={(e) => setReason(e.target.value)}>
              {CANCEL_REASONS.map((r) => (
                <option key={r} value={r}>
                  {t(enumLabelKey('cancelReason', r))}
                </option>
              ))}
            </Select>
          </label>
          {cancelError && (
            <div className="mt-3">
              <ErrorNote message={t('cancelFailed')} />
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setCancelId(null)}>{t('close')}</Button>
            <Button variant="danger" busy={busy} onClick={() => void submitCancel()}>
              {t('cancelOrder')}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function FillsPanel({
  runId,
  costPpm,
  onMutated,
}: {
  runId: number;
  costPpm?: number;
  onMutated?: () => void;
}) {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => api.listFills(runId), [runId]);
  const [edit, setEdit] = useState<FillDto | null>(null);
  const [confirmDel, setConfirmDel] = useState<FillDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [delError, setDelError] = useState(false);

  const submitDelete = async () => {
    if (!confirmDel) return;
    setBusy(true);
    setDelError(false);
    try {
      await api.deleteFill(runId, confirmDel.id);
      setConfirmDel(null);
      await reload();
      onMutated?.();
    } catch {
      setDelError(true);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner />;
  if (error) return <PanelState error={error} onRetry={() => void reload()} />;
  const fills = data ?? [];
  // One deletable fill per bucket: the newest (max id) row of that bucket —
  // the server only accepts deleting a bucket's last fill. The list from
  // GET /fills is id-ascending, so the last row seen per bucket wins.
  const newestPerBucket = new Map<number, number>();
  for (const f of fills) newestPerBucket.set(f.bucketIdx, f.id);
  const deletableIds = new Set(newestPerBucket.values());
  return (
    <>
      <FillTable
        fills={fills}
        onEdit={setEdit}
        deletableIds={deletableIds}
        onDelete={(f) => setConfirmDel(f)}
      />
      {edit && (
        <FillDialog
          runId={runId}
          costPpm={costPpm}
          fill={edit}
          deletable={deletableIds.has(edit.id)}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            void reload();
            onMutated?.();
          }}
        />
      )}
      {confirmDel && (
        <Modal title={t('dialog.delete')} onClose={() => setConfirmDel(null)}>
          <p className="text-sm">{t('dialog.deleteWarning', { n: confirmDel.shares })}</p>
          {delError && (
            <div className="mt-3">
              <ErrorNote message={t('dialog.deleteFailed')} />
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setConfirmDel(null)}>{t('cancel')}</Button>
            <Button variant="danger" busy={busy} onClick={() => void submitDelete()}>
              {t('dialog.deleteConfirm')}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

export function NotificationsPanel({ runId }: { runId: number }) {
  const { data, error, loading, reload } = useAsync(() => api.listNotifications(runId), [runId]);
  if (loading) return <Spinner />;
  if (error) return <PanelState error={error} onRetry={() => void reload()} />;
  return <NoticeList notifications={data ?? []} />;
}
