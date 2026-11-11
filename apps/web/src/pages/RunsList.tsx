// Runs list: filter by status (Active by default), trigger the morning job,
// create a run, and pause/resume/close runs in bulk via row checkboxes.
import { useMemo, useState } from 'react';

import { api } from '../api';
import type { RunStatus } from '../api';
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
import { RUN_STATUSES, bulkPlan, enumLabelKey, runStatusTone } from '../viewmodels';

export function RunsListPage() {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => api.listRuns(), []);
  const [filter, setFilter] = useState<string>('active');
  const [showNew, setShowNew] = useState(false);
  const [triggerBusy, setTriggerBusy] = useState(false);
  const [triggerResult, setTriggerResult] = useState<string | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<RunStatus | null>(null);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [showBulkClose, setShowBulkClose] = useState(false);

  const runs = useMemo(
    () => (data ?? []).filter((r) => filter === 'all' || r.status === filter),
    [data, filter],
  );

  // Only *visible* selected rows are planned: ids that left the current filter
  // (or left the world) can never be sent to the bulk endpoint.
  const plan = useMemo(
    () => bulkPlan(runs.filter((r) => selected.has(r.id)).map((r) => ({ id: r.id, status: r.status }))),
    [runs, selected],
  );
  const allVisibleSelected = runs.length > 0 && runs.every((r) => selected.has(r.id));

  // Any list-refreshing action invalidates the selection (statuses may have
  // moved, rows may have left the filter), so every reload-completing action
  // clears it.
  const changeFilter = (value: string) => {
    setFilter(value);
    setSelected(new Set());
  };

  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      const deselect = runs.length > 0 && runs.every((r) => prev.has(r.id));
      for (const r of runs) {
        if (deselect) next.delete(r.id);
        else next.add(r.id);
      }
      return next;
    });
  };

  const toggleRow = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const triggerMorning = async () => {
    setTriggerBusy(true);
    setTriggerResult(null);
    setTriggerError(null);
    try {
      setTriggerResult(await api.triggerMorning());
      setSelected(new Set());
      await reload();
    } catch (err) {
      setTriggerError(err instanceof Error ? err.message : String(err));
    } finally {
      setTriggerBusy(false);
    }
  };

  const runBulk = async (ids: number[], status: RunStatus) => {
    setBulkBusy(status);
    setBulkResult(null);
    setBulkError(null);
    try {
      const updated = await api.bulkSetRunStatus(ids, status);
      setSelected(new Set());
      await reload();
      setBulkResult(t('bulkDone', { count: updated }));
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('runsTitle')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label={t('runFilterStatus')} value={filter} onChange={(e) => changeFilter(e.target.value)}>
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
      {bulkResult !== null && (
        <div role="status" className="rounded border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-primary">
          {bulkResult}
        </div>
      )}
      {bulkError !== null && <ErrorNote message={bulkError} />}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-border bg-muted/40 px-3 py-2">
          <span className="text-sm font-medium">{t('bulkSelected', { count: selected.size })}</span>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              busy={bulkBusy === 'paused'}
              disabled={plan.pause.length === 0}
              onClick={() => void runBulk(plan.pause, 'paused')}
            >
              {t('bulkPause')} ({plan.pause.length})
            </Button>
            <Button
              busy={bulkBusy === 'active'}
              disabled={plan.resume.length === 0}
              onClick={() => void runBulk(plan.resume, 'active')}
            >
              {t('bulkResume')} ({plan.resume.length})
            </Button>
            <Button variant="danger" disabled={plan.close.length === 0} onClick={() => setShowBulkClose(true)}>
              {t('bulkClose')} ({plan.close.length})
            </Button>
          </div>
        </div>
      )}

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
                <Th>
                  <input
                    type="checkbox"
                    aria-label={t('bulkSelectAll')}
                    checked={allVisibleSelected}
                    onChange={() => toggleAllVisible()}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                </Th>
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
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={r.name}
                      checked={selected.has(r.id)}
                      onChange={() => toggleRow(r.id)}
                      className="h-3.5 w-3.5 accent-primary"
                    />
                  </Td>
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
              setSelected(new Set());
              void reload();
            }}
            onCancel={() => setShowNew(false)}
          />
        </Modal>
      )}

      {showBulkClose && (
        <Modal title={t('bulkClose')} onClose={() => setShowBulkClose(false)}>
          <p className="mb-4 text-sm">{t('bulkCloseConfirm', { count: plan.close.length })}</p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setShowBulkClose(false)}>{t('cancel')}</Button>
            <Button
              variant="danger"
              busy={bulkBusy === 'closed'}
              onClick={() => {
                setShowBulkClose(false);
                void runBulk(plan.close, 'closed');
              }}
            >
              {t('confirm')}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
