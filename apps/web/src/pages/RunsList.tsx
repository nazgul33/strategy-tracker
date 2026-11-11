// Runs list: filter by status, trigger the morning job, create a run.
import { useMemo, useState } from 'react';

import { api } from '../api';
import { CreateRunForm } from '../components/forms/CreateRunForm';
import { useAsync } from '../components/hooks';
import {
  Badge,
  Button,
  Card,
  EmptyNote,
  ErrorNote,
  Modal,
  Select,
  Spinner,
  TableWrap,
  Td,
  Th,
} from '../components/ui';
import { bpPercent, centsUsd, isoDateTime } from '../format';
import { useT } from '../i18n';
import { RUN_STATUSES, enumLabelKey, runStatusTone } from '../viewmodels';

export function RunsListPage() {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => api.listRuns(), []);
  const [filter, setFilter] = useState<string>('all');
  const [showNew, setShowNew] = useState(false);
  const [triggerBusy, setTriggerBusy] = useState(false);
  const [triggerResult, setTriggerResult] = useState<string | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  const runs = useMemo(
    () => (data ?? []).filter((r) => filter === 'all' || r.status === filter),
    [data, filter],
  );

  const triggerMorning = async () => {
    setTriggerBusy(true);
    setTriggerResult(null);
    setTriggerError(null);
    try {
      setTriggerResult(await api.triggerMorning());
      await reload();
    } catch (err) {
      setTriggerError(err instanceof Error ? err.message : String(err));
    } finally {
      setTriggerBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('runsTitle')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={t('runFilterStatus')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">{t('allStatuses')}</option>
            {RUN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(enumLabelKey('status', s))}
              </option>
            ))}
          </Select>
          <Button busy={triggerBusy} onClick={() => void triggerMorning()}>
            {t('triggerMorning')}
          </Button>
          <Button variant="primary" onClick={() => setShowNew(true)}>
            {t('runNew')}
          </Button>
        </div>
      </div>

      {triggerResult !== null && (
        <div role="status" className="rounded border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-primary">
          {t('triggerMorningResult', { result: triggerResult })}
        </div>
      )}
      {triggerError !== null && <ErrorNote message={triggerError} />}

      <Card>
        {loading ? (
          <Spinner />
        ) : error ? (
          <div className="flex items-center gap-3">
            <ErrorNote message={error} />
            <Button onClick={() => void reload()}>{t('retry')}</Button>
          </div>
        ) : runs.length === 0 ? (
          <EmptyNote>{t('runEmpty')}</EmptyNote>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('runColId')}</Th>
                <Th>{t('runColTicker')}</Th>
                <Th>{t('runColStrategy')}</Th>
                <Th className="text-right">{t('runColPool')}</Th>
                <Th>{t('runColStatus')}</Th>
                <Th>{t('runColStarted')}</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="hover:bg-muted/50">
                  <Td className="tabular-nums text-muted-foreground">{r.id}</Td>
                  <Td>
                    <a href={`#/runs/${r.id}`} className="font-medium text-primary hover:underline">
                      {r.name}
                    </a>
                    <div className="font-mono text-[11px] text-muted-foreground">{r.ticker}</div>
                  </Td>
                  <Td className="text-muted-foreground">
                    {r.strategyKey === 'mean-reversion' ? t('runStrategyMr') : r.strategyKey}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {centsUsd(r.poolCents)}
                    <div className="text-[11px] text-muted-foreground">{bpPercent(r.costPpm / 100)}</div>
                  </Td>
                  <Td>
                    <Badge tone={runStatusTone(r.status)}>{t(enumLabelKey('status', r.status))}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap tabular-nums text-muted-foreground">{isoDateTime(r.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      {showNew && (
        <Modal title={t('runNew')} onClose={() => setShowNew(false)}>
          <CreateRunForm
            onCreated={() => {
              setShowNew(false);
              void reload();
            }}
            onCancel={() => setShowNew(false)}
          />
        </Modal>
      )}
    </div>
  );
}
