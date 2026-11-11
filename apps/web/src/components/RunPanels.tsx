// Tab panels for the run detail page: each one owns its own fetch so tab
// switches stay cheap and a panel-level failure never blanks the whole page.
import { useState } from 'react';

import { api } from '../api';
import { useAsync } from '../components/hooks';
import { FillTable } from './FillTable';
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

export function FillsPanel({ runId }: { runId: number }) {
  const { data, error, loading, reload } = useAsync(() => api.listFills(runId), [runId]);
  if (loading) return <Spinner />;
  if (error) return <PanelState error={error} onRetry={() => void reload()} />;
  return <FillTable fills={data ?? []} />;
}

export function NotificationsPanel({ runId }: { runId: number }) {
  const { data, error, loading, reload } = useAsync(() => api.listNotifications(runId), [runId]);
  if (loading) return <Spinner />;
  if (error) return <PanelState error={error} onRetry={() => void reload()} />;
  return <NoticeList notifications={data ?? []} />;
}
