// Run detail header: title block and the lifecycle / add-fill / upload actions row.
import type { RunDetailDto, RunStatus } from '../api';
import { centsUsd, costPercentText, isoDateTime } from '../format';
import { useT } from '../i18n';
import { enumLabelKey, runActions, runStatusTone } from '../viewmodels';
import { Badge, Button } from './ui';

export function RunHeader({
  run,
  busyStatus,
  onEditPool,
  onAskClose,
  onSetStatus,
  onAddFill,
  onUpload,
}: {
  run: Pick<RunDetailDto, 'name' | 'ticker' | 'status' | 'strategyKey' | 'costPpm' | 'poolCents' | 'createdAt'>;
  busyStatus: RunStatus | null;
  onEditPool: () => void;
  onAskClose: () => void;
  onSetStatus: (status: RunStatus) => void;
  onAddFill: () => void;
  onUpload: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          {run.name}
          <span className="font-mono text-sm text-muted-foreground">{run.ticker}</span>
          <Badge tone={runStatusTone(run.status)}>{t(enumLabelKey('status', run.status))}</Badge>
        </h1>
        <p className="text-sm text-muted-foreground">
          {run.strategyKey === 'mean-reversion' ? t('runStrategyMr') : run.strategyKey} · {costPercentText(run.costPpm)}{' '}
          · {centsUsd(run.poolCents)} · {isoDateTime(run.createdAt)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onEditPool}>{t('poolEdit')}</Button>
        {runActions(run.status).map((action) =>
          action === 'close' ? (
            <Button key={action} variant="danger" onClick={onAskClose}>
              {t('actionClose')}
            </Button>
          ) : (
            <Button
              key={action}
              variant={action === 'pause' ? 'secondary' : 'primary'}
              busy={busyStatus === (action === 'pause' ? 'paused' : 'active')}
              onClick={() => onSetStatus(action === 'pause' ? 'paused' : 'active')}
            >
              {t(action === 'pause' ? 'actionPause' : 'actionResume')}
            </Button>
          ),
        )}
        <Button data-testid="tabManual" variant="secondary" onClick={onAddFill}>
          {t('tabManual')}
        </Button>
        <Button data-testid="uploadScreenshot" variant="secondary" onClick={onUpload}>
          {t('upload.title')}
        </Button>
      </div>
    </div>
  );
}
