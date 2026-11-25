// VR runs list: every value-rebalancing run with its books, and the "New VR run" dialog.
import { useState } from 'react';

import { vrApi } from '../api.vr';
import { useAsync } from '../components/hooks';
import { VrCreateForm } from '../components/vr/VrCreateForm';
import { Badge, Button, Card, EmptyNote, ErrorNote, Modal, Spinner, TableWrap, Td, Th } from '../components/ui';
import { centsUsd } from '../format';
import { useT } from '../i18n';
import { enumLabelKey, runStatusTone } from '../viewmodels';

export function VrRunsPage() {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => vrApi.listRuns(), []);
  const [showNew, setShowNew] = useState(false);
  const runs = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('vr.runsTitle')}</h1>
        <Button variant="primary" onClick={() => setShowNew(true)}>
          {t('vr.new')}
        </Button>
      </div>

      <Card>
        {loading ? (
          <Spinner />
        ) : error ? (
          <div className="flex items-center gap-3">
            <ErrorNote message={error} />
            <Button onClick={() => void reload()}>{t('retry')}</Button>
          </div>
        ) : runs.length === 0 ? (
          <EmptyNote>{t('vr.empty')}</EmptyNote>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('vr.colName')}</Th>
                <Th>{t('vr.colStatus')}</Th>
                <Th className="text-right">{t('vr.colShares')}</Th>
                <Th className="text-right">{t('vr.colPool')}</Th>
                <Th className="text-right">{t('vr.colV')}</Th>
                <Th className="text-right">{t('vr.colValue')}</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="hover:bg-muted/50">
                  <Td>
                    <a href={`#/vr/${r.id}`} className="font-medium text-primary hover:underline">
                      {r.name}
                    </a>
                    <div className="font-mono text-[11px] text-muted-foreground">{r.ticker}</div>
                  </Td>
                  <Td>
                    <Badge tone={runStatusTone(r.status)}>{t(enumLabelKey('status', r.status))}</Badge>
                  </Td>
                  <Td className="text-right tabular-nums">{r.shares}</Td>
                  <Td className="text-right tabular-nums">{centsUsd(r.poolCents)}</Td>
                  <Td className="text-right tabular-nums">{centsUsd(r.vCents)}</Td>
                  <Td className="text-right tabular-nums">{centsUsd(r.valueCents)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      {showNew && (
        <Modal title={t('vr.new')} onClose={() => setShowNew(false)} closeOnEscape={false}>
          <VrCreateForm
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
