// VR run page: header with the status actions, summary, ladders and the Fills / Pending / Cash / Cycles / Alerts tabs.
import { useState } from 'react';
import type { ReactNode } from 'react';

import type { RunStatus } from '../api';
import { vrApi } from '../api.vr';
import { useAsync } from '../components/hooks';
import { UploadDialog } from '../components/forms/UploadDialog';
import type { UploadCloseOutcome } from '../components/forms/UploadDialog';
import { NotificationsPanel } from '../components/RunPanels';
import { Badge, Button, Card, ErrorNote, Modal, Spinner } from '../components/ui';
import { VrCashPanel } from '../components/vr/VrCashPanel';
import { VrCyclesPanel } from '../components/vr/VrCyclesPanel';
import { VrFillsPanel } from '../components/vr/VrFillsPanel';
import { VrLadders } from '../components/vr/VrLadders';
import { VrPendingPanel } from '../components/vr/VrPendingPanel';
import { VrSettingsModal } from '../components/vr/VrSettingsModal';
import { VrSummary } from '../components/vr/VrSummary';
import { errorText } from '../errortext';
import { costPercentText, isoDateTime } from '../format';
import { useT } from '../i18n';
import { enumLabelKey, runActions, runStatusTone } from '../viewmodels';

type Tab = 'fills' | 'pending' | 'cash' | 'cycles' | 'alerts';

const TABS: { id: Tab; labelKey: string }[] = [
  { id: 'fills', labelKey: 'tabFills' },
  { id: 'pending', labelKey: 'tabPending' },
  { id: 'cash', labelKey: 'vr.tabCash' },
  { id: 'cycles', labelKey: 'vr.tabCycles' },
  { id: 'alerts', labelKey: 'tabNotifications' },
];

export function VrRunPage({ id, initialTab }: { id: number; initialTab?: 'pending' }) {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => vrApi.getRun(id), [id]);
  const [tab, setTab] = useState<Tab>(initialTab ?? 'fills');
  const [panelKey, setPanelKey] = useState(0);
  const [busyStatus, setBusyStatus] = useState<RunStatus | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showClose, setShowClose] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  const selectTab = (next: Tab) => {
    setTab(next);
    setPanelKey((k) => k + 1); // remount self-fetching panels so they re-read
    void reload();
  };

  const setStatus = async (status: RunStatus) => {
    setBusyStatus(status);
    setActionError(null);
    try {
      await vrApi.setStatus(id, status);
      await reload();
    } catch (err) {
      setActionError(errorText(err, t, 'vrErr'));
    } finally {
      setBusyStatus(null);
    }
  };

  const root = (content: ReactNode) => (
    <div data-testid="vr-run-page" data-run-id={id} className="space-y-4">
      {content}
    </div>
  );

  if (loading && !data) return root(<Spinner />);
  if (!data) {
    return root(
      error ? (
        <div className="flex items-center gap-3">
          <ErrorNote message={error} />
          <Button onClick={() => void reload()}>{t('retry')}</Button>
        </div>
      ) : (
        <Spinner />
      ),
    );
  }

  const { run } = data;
  const panelProps = { runId: id, costPpm: run.costPpm, today: data.today, onChanged: () => void reload() };

  return root(
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            {run.name}
            <span className="font-mono text-sm text-muted-foreground">{run.ticker}</span>
            <Badge tone={runStatusTone(run.status)}>{t(enumLabelKey('status', run.status))}</Badge>
          </h1>
          <p className="text-sm text-muted-foreground">
            {costPercentText(run.costPpm)} · {isoDateTime(run.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {runActions(run.status).map((action) =>
            action === 'close' ? (
              <Button key={action} variant="danger" disabled={busyStatus !== null} onClick={() => setShowClose(true)}>
                {t('actionClose')}
              </Button>
            ) : (
              <Button
                key={action}
                variant={action === 'pause' ? 'secondary' : 'primary'}
                busy={busyStatus === (action === 'pause' ? 'paused' : 'active')}
                disabled={busyStatus !== null}
                onClick={() => void setStatus(action === 'pause' ? 'paused' : 'active')}
              >
                {t(action === 'pause' ? 'actionPause' : 'actionResume')}
              </Button>
            ),
          )}
          <Button data-testid="uploadScreenshot" variant="secondary" onClick={() => setUploadOpen(true)}>
            {t('upload.title')}
          </Button>
          {run.status !== 'closed' && <Button onClick={() => setShowSettings(true)}>{t('vr.settings')}</Button>}
        </div>
      </div>

      {actionError !== null && <ErrorNote message={actionError} />}

      <Card>
        <VrSummary detail={data} />
      </Card>
      <Card>
        <VrLadders detail={data} />
      </Card>

      <div className="flex flex-wrap gap-1">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            data-testid={`vrTab-${item.id}`}
            onClick={() => selectTab(item.id)}
            className={`rounded px-3 py-1.5 text-sm font-medium ${
              tab === item.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {item.id === 'pending' && data.pendingCount > 0
              ? t('vr.tabPendingCount', { n: data.pendingCount })
              : t(item.labelKey)}
          </button>
        ))}
      </div>

      <Card>
        {tab === 'fills' && <VrFillsPanel key={`f${panelKey}`} {...panelProps} />}
        {tab === 'pending' && <VrPendingPanel key={`p${panelKey}`} {...panelProps} />}
        {tab === 'cash' && <VrCashPanel key={`c${panelKey}`} {...panelProps} />}
        {tab === 'cycles' && <VrCyclesPanel key={`y${panelKey}`} runId={id} />}
        {tab === 'alerts' && <NotificationsPanel key={`n${panelKey}`} runId={id} />}
      </Card>

      {showClose && (
        <Modal title={t('actionClose')} onClose={() => setShowClose(false)} dismissible={busyStatus !== 'closed'}>
          <p className="mb-4 text-sm">{t('confirmClose')}</p>
          <div className="flex justify-end gap-2">
            <Button disabled={busyStatus === 'closed'} onClick={() => setShowClose(false)}>
              {t('cancel')}
            </Button>
            <Button
              variant="danger"
              busy={busyStatus === 'closed'}
              onClick={() => {
                void setStatus('closed').then(() => setShowClose(false));
              }}
            >
              {t('confirm')}
            </Button>
          </div>
        </Modal>
      )}

      {uploadOpen && (
        <UploadDialog
          runId={id}
          onClose={({ uploaded, goToPending }: UploadCloseOutcome) => {
            setUploadOpen(false);
            if (uploaded) selectTab(goToPending ? 'pending' : tab);
          }}
        />
      )}

      {showSettings && (
        <VrSettingsModal run={run} onClose={() => setShowSettings(false)} onSaved={() => void reload()} />
      )}
    </>,
  );
}
