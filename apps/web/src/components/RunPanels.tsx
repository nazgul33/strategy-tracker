// Tab panels for the run detail page: each one owns its own fetch so tab
// switches stay cheap and a panel-level failure never blanks the whole page.
import { useState } from 'react';

import { api } from '../api';
import { useAsync } from '../components/hooks';
import { FillTable } from './FillTable';
import { NoticeList } from './NoticeList';
import { OrderTable } from './OrderTable';
import { Button, ErrorNote, Input, Spinner } from './ui';
import { useT } from '../i18n';

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
        <OrderTable orders={data ?? []} />
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
