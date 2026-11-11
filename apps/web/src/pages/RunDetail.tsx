// Run detail: header + progress stats, bucket board, lifecycle actions,
// pool top-up, and the tabbed panels (orders / pending / fills / history /
// notifications / manual capture).
import { useState } from 'react';

import { api, usdToCents } from '../api';
import type { RunStatus } from '../api';
import { BucketBoard } from '../components/BucketBoard';
import { useAsync } from '../components/hooks';
import { ManualCaptureForm } from '../components/forms/ManualCaptureForm';
import { PendingTable } from '../components/forms/PendingTable';
import { FillsPanel, NotificationsPanel, OrdersPanel } from '../components/RunPanels';
import { RunHistory } from '../components/RunHistory';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Modal,
  SectionTitle,
  Spinner,
  Stat,
} from '../components/ui';
import { bpPercent, centsUsd, isoDateTime, percent, signedCentsUsd } from '../format';
import { useT } from '../i18n';
import { enumLabelKey, pnlBadgeTone, poolAfterTopUp, runActions, runStatusTone, toneFor } from '../viewmodels';

type Tab = 'orders' | 'pending' | 'fills' | 'history' | 'notifications' | 'manual';

const TABS: { id: Tab; labelKey: string }[] = [
  { id: 'orders', labelKey: 'tabOrders' },
  { id: 'pending', labelKey: 'tabPending' },
  { id: 'fills', labelKey: 'tabFills' },
  { id: 'history', labelKey: 'tabHistory' },
  { id: 'notifications', labelKey: 'tabNotifications' },
  { id: 'manual', labelKey: 'tabManual' },
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
        </div>
      </div>

      {actionError !== null && <ErrorNote message={actionError} />}

      <Card>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Stat label={t('statHeld')} value={pv.heldCount} />
          <Stat label={t('statCash')} value={centsUsd(pv.cashCents)} />
          <Stat label={t('statExposure')} value={centsUsd(pv.exposureCents)} />
          <Stat
            label={t('statRealized')}
            value={signedCentsUsd(pv.realizedCents)}
            tone={pnlBadgeTone(toneFor(pv.realizedCents))}
          />
          <Stat label={t('statWinRate')} value={percent(pv.winRate)} />
        </div>
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
        {tab === 'pending' && <PendingTable key={`p${panelKey}`} runId={id} />}
        {tab === 'fills' && <FillsPanel key={`f${panelKey}`} runId={id} />}
        {tab === 'history' && <RunHistory closed={run.state.closed} />}
        {tab === 'notifications' && <NotificationsPanel key={`n${panelKey}`} runId={id} />}
        {tab === 'manual' && (
          <ManualCaptureForm
            runId={id}
            onAdded={() => {
              setPanelKey((k) => k + 1);
              void reload();
            }}
          />
        )}
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
        <PoolModal
          runId={id}
          poolCents={run.poolCents}
          onClose={() => setShowPool(false)}
          onAdded={() => void reload()}
        />
      )}
    </div>
  );
}

function PoolModal({
  runId,
  poolCents,
  onClose,
  onAdded,
}: {
  runId: number;
  poolCents: number;
  onClose: () => void;
  onAdded: () => void;
}) {
  const t = useT();
  const [amount, setAmount] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    // The pool endpoint sets an ABSOLUTE amount — send current pool + addition,
    // otherwise a "top up $500" would shrink a larger pool to $500.
    const add = usdToCents(amount);
    const total = add === null ? null : poolAfterTopUp(poolCents, add);
    if (total === null) {
      setFieldError(t('poolInvalidAmount'));
      return;
    }
    setBusy(true);
    setSubmitError(null);
    try {
      await api.setPool(runId, total);
      setAdded(true);
      onAdded();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('poolTitle')} onClose={onClose}>
      {added ? (
        <div className="space-y-3">
          <div role="status" className="rounded border border-positive/40 bg-positive/10 px-3 py-2 text-sm text-positive">
            {t('poolAdded')}
          </div>
          <div className="flex justify-end">
            <Button onClick={onClose}>{t('close')}</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {fieldError !== null && <ErrorNote message={fieldError} />}
          {submitError !== null && <ErrorNote message={submitError} />}
          <Field label={t('poolAddAmount')}>
            <Input
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setFieldError(null);
              }}
              inputMode="decimal"
              placeholder="1000"
              autoFocus
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t('cancel')}</Button>
            <Button variant="primary" busy={busy} onClick={() => void submit()}>
              {t('poolAddBtn')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
