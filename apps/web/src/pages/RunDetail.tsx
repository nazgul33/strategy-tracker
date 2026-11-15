// Run detail: header + progress stats, price-history chart, bucket board,
// lifecycle actions, the Edit-run modal (extracted to forms/EditRunModal),
// and the tabbed panels (orders / pending / fills / history / notifications).
import { useState } from 'react';

import { api, ApiError } from '../api';
import type { RunStatus } from '../api';
import { BucketBoard } from '../components/BucketBoard';
import { useAsync } from '../components/hooks';
import { PriceChart } from '../components/PriceChart';
import { RecalcResultModal, type RecalcResult } from '../components/RecalcSummary';
import { EditRunModal } from '../components/forms/EditRunModal';
import { FillDialog } from '../components/forms/FillDialog';
import { CorrectionList } from '../components/forms/CorrectionList';
import { PendingTable } from '../components/forms/PendingTable';
import { FillsPanel, NotificationsPanel, OrdersPanel } from '../components/RunPanels';
import { RunHistory } from '../components/RunHistory';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Modal,
  SectionTitle,
  Spinner,
  Stat,
} from '../components/ui';
import { bpPercent, centsUsd, gapText, isoDateTime, percent, signedCentsUsd } from '../format';
import { useT } from '../i18n';
import { enumLabelKey, pnlBadgeTone, runActions, runStatusTone, toneFor } from '../viewmodels';

type Tab = 'orders' | 'pending' | 'fills' | 'history' | 'notifications';

const TABS: { id: Tab; labelKey: string }[] = [
  { id: 'orders', labelKey: 'tabOrders' },
  { id: 'pending', labelKey: 'tabPending' },
  { id: 'fills', labelKey: 'tabFills' },
  { id: 'history', labelKey: 'tabHistory' },
  { id: 'notifications', labelKey: 'tabNotifications' },
];

export function RunDetailPage({ id }: { id: number }) {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => api.getRun(id), [id]);

  const [tab, setTab] = useState<Tab>('orders');
  const [panelKey, setPanelKey] = useState(0);
  const [busyStatus, setBusyStatus] = useState<RunStatus | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showClose, setShowClose] = useState(false);
  const [showPool, setShowPool] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [recalcResult, setRecalcResult] = useState<RecalcResult | null>(null);

  const selectTab = (next: Tab) => {
    setTab(next);
    setPanelKey((k) => k + 1); // remount self-fetching panels so they re-read
    void reload();
  };

  const setStatus = async (status: RunStatus) => {
    setBusyStatus(status);
    setActionError(null);
    try {
      await api.setRunStatus(id, status);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyStatus(null);
    }
  };

  const recalc = async () => {
    setActionError(null);
    try {
      const res = await api.recalcRun(id);
      // fillCount is only reported by the recalc endpoint (never absent here).
      setRecalcResult({ deltaCents: res.deltaCents, fillCount: res.fillCount! });
      await reload();
    } catch (err) {
      if (err instanceof ApiError) {
        // fillErr.* pattern: known recalcErr.* keys read localized, the rest
        // fall back to the raw server code.
        const key = `recalcErr.${err.code}`;
        const msg = t(key);
        setActionError(msg === key ? err.code : msg);
      } else {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  if (loading && !data) return <Spinner />;
  if (!data) {
    return error ? (
      <div className="flex items-center gap-3">
        <ErrorNote message={error} />
        <Button onClick={() => void reload()}>{t('retry')}</Button>
      </div>
    ) : (
      <Spinner />
    );
  }

  const run = data;
  const pv = run.progressView;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            {run.name}
            <span className="font-mono text-sm text-muted-foreground">{run.ticker}</span>
            <Badge tone={runStatusTone(run.status)}>{t(enumLabelKey('status', run.status))}</Badge>
          </h1>
          <p className="text-sm text-muted-foreground">
            {run.strategyKey === 'mean-reversion' ? t('runStrategyMr') : run.strategyKey} · {bpPercent(run.costPpm / 100)}{' '}
            · {centsUsd(run.poolCents)} · {isoDateTime(run.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setShowPool(true)}>{t('poolEdit')}</Button>
          {runActions(run.status).map((action) =>
            action === 'close' ? (
              <Button key={action} variant="danger" onClick={() => setShowClose(true)}>
                {t('actionClose')}
              </Button>
            ) : (
              <Button
                key={action}
                variant={action === 'pause' ? 'secondary' : 'primary'}
                busy={busyStatus === (action === 'pause' ? 'paused' : 'active')}
                onClick={() => void setStatus(action === 'pause' ? 'paused' : 'active')}
              >
                {t(action === 'pause' ? 'actionPause' : 'actionResume')}
              </Button>
            ),
          )}
          <Button data-testid="tabManual" variant="secondary" onClick={() => setManualOpen(true)}>
            {t('tabManual')}
          </Button>
        </div>
      </div>

      {actionError !== null && <ErrorNote message={actionError} />}

      <Card>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label={t('statHeld')} value={pv.heldCount} />
          <Stat label={t('statCash')} value={centsUsd(pv.cashCents)} />
          <Stat label={t('statExposure')} value={centsUsd(pv.exposureCents)} />
          <Stat
            label={t('statRealized')}
            value={signedCentsUsd(pv.realizedCents)}
            tone={pnlBadgeTone(toneFor(pv.realizedCents))}
          />
          <Stat label={t('statWinRate')} value={percent(pv.winRate)} />
          <Stat label={t('runDetail.buyGap')} value={gapText(run.buyGapPpm / 10_000, t)} />
          <Stat label={t('runDetail.sellGap')} value={gapText(run.sellGapPpm / 10_000, t)} />
        </div>
      </Card>

      <Card>
        <SectionTitle>{t('runDetail.priceHistoryTitle')}</SectionTitle>
        <PriceChart runId={run.id} />
      </Card>

      <Card>
        <SectionTitle>{t('bucketBoard')}</SectionTitle>
        <BucketBoard buckets={run.state.buckets} ages={run.state.ages} />
      </Card>

      <div className="flex flex-wrap gap-1">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => selectTab(item.id)}
            className={`rounded px-3 py-1.5 text-sm font-medium ${
              tab === item.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>

      <Card>
        {tab === 'orders' && <OrdersPanel runId={id} />}
        {tab === 'pending' && (
          <div className="space-y-6">
            {/* No remount key: CorrectionList reloads itself after an action. */}
            <CorrectionList
              runId={id}
              onChanged={() => {
                setPanelKey((k) => k + 1); // re-read PendingTable only
                void reload();
              }}
            />
            <PendingTable key={`p${panelKey}`} runId={id} />
          </div>
        )}
        {tab === 'fills' && (
          <FillsPanel
            key={`f${panelKey}`}
            runId={id}
            costPpm={run.costPpm}
            closedIndexes={run.state.closed.map((c) => c.index)}
            onMutated={() => {
              setPanelKey((k) => k + 1);
              void reload();
            }}
          />
        )}
        {tab === 'history' && <RunHistory closed={run.state.closed} onRecalc={recalc} />}
        {tab === 'notifications' && <NotificationsPanel key={`n${panelKey}`} runId={id} />}
      </Card>

      {showClose && (
        <Modal title={t('actionClose')} onClose={() => setShowClose(false)}>
          <p className="mb-4 text-sm">{t('confirmClose')}</p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setShowClose(false)}>{t('cancel')}</Button>
            <Button
              variant="danger"
              busy={busyStatus === 'closed'}
              onClick={() => {
                setShowClose(false);
                void setStatus('closed');
              }}
            >
              {t('confirm')}
            </Button>
          </div>
        </Modal>
      )}

      {showPool && (
        <EditRunModal
          runId={id}
          poolCents={run.poolCents}
          initialBuyPpm={run.buyGapPpm}
          initialSellPpm={run.sellGapPpm}
          onClose={() => setShowPool(false)}
          onSaved={() => void reload()}
        />
      )}
      {manualOpen && (
        <FillDialog runId={run.id} costPpm={run.costPpm} initialSide="buy"
          onClose={() => setManualOpen(false)}
          onSaved={() => { setManualOpen(false); setPanelKey((k) => k + 1); void reload(); }} />
      )}
      {recalcResult !== null && (
        <div data-testid="recalcResult">
          <RecalcResultModal
            result={recalcResult}
            // Dismissing (OK, ✕ or backdrop) reloads the run: a zero-delta edit
            // can still re-open a closed bucket or change cash shown elsewhere.
            onClose={() => {
              setRecalcResult(null);
              void reload();
            }}
          />
        </div>
      )}
    </div>
  );
}
