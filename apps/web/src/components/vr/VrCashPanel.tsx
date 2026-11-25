// Cash tab of a VR run: the cash movements newest first, with add, edit and delete.
import { useState } from 'react';
import { vrApi } from '../../api.vr';
import type { VrCashDto } from '../../api.vr.types';
import { signedCentsUsd } from '../../format';
import { useT } from '../../i18n';
import { enumLabelKey } from '../../viewmodels';
import { useAsync } from '../hooks';
import { Badge, Button, EmptyNote, Spinner, TableWrap, Td, Th } from '../ui';
import { VrCashDialog } from './VrCashDialog';
import { VrEntryDate, type VrPanelProps } from './VrFillsPanel';
import { VrPanelState } from './VrPanelState';

export function VrCashPanel({ runId, today, onChanged }: VrPanelProps) {
  const t = useT();
  // A movement carries its cycle's row id; the cycles give the number to show.
  const { data, error, loading, reload } = useAsync(
    () => Promise.all([vrApi.listCash(runId), vrApi.listCycles(runId)]),
    [runId],
  );
  const [dialog, setDialog] = useState<{ move?: VrCashDto; deleting?: boolean } | null>(null);

  const body = () => {
    if (loading) return <Spinner />;
    if (error) return <VrPanelState error={error} onRetry={() => void reload()} />;
    const [moves, cycles] = data ?? [[], []];
    const seqById = new Map(cycles.map((c) => [c.id, c.seq]));
    const cycleText = (m: VrCashDto) => {
      const seq = m.cycleId === null ? undefined : seqById.get(m.cycleId);
      return seq === undefined ? '' : t('vr.cycleNo', { seq });
    };
    return (
      <>
        <div className="mb-3 flex justify-end">
          <Button variant="primary" data-testid="vrAddCash" onClick={() => setDialog({})}>
            {t('vr.addCash')}
          </Button>
        </div>
        {moves.length === 0 ? (
          <EmptyNote>{t('vr.cashEmpty')}</EmptyNote>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('vr.colDate')}</Th>
                <Th>{t('vr.colKind')}</Th>
                <Th className="text-right">{t('vr.colAmount')}</Th>
                <Th>{t('manualNote')}</Th>
                <Th>{t('vr.colCycle')}</Th>
                <Th className="text-right">{t('fillColActions')}</Th>
              </tr>
            </thead>
            <tbody>
              {moves.map((m) => (
                <tr key={m.id}>
                  <Td className="whitespace-nowrap tabular-nums">
                    <VrEntryDate date={m.movedOn} earlier={m.beforeCycle} />
                  </Td>
                  <Td>
                    <Badge tone="neutral">{t(enumLabelKey('vr.kind', m.kind))}</Badge>
                  </Td>
                  <Td className="text-right tabular-nums">{signedCentsUsd(m.amountCents)}</Td>
                  <Td>{m.note ?? ''}</Td>
                  <Td className="whitespace-nowrap">{cycleText(m)}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button data-testid={`vrCashEdit-${m.id}`} onClick={() => setDialog({ move: m })}>
                        {t('fillEdit')}
                      </Button>
                      {m.kind !== 'open' && (
                        <Button data-testid={`vrCashDelete-${m.id}`} onClick={() => setDialog({ move: m, deleting: true })}>
                          {t('dialog.delete')}
                        </Button>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </>
    );
  };

  return (
    <div data-testid="vrCashPanel" data-run-id={runId}>
      {body()}
      {dialog && (
        <VrCashDialog
          runId={runId}
          today={today}
          move={dialog.move}
          startOnDelete={dialog.deleting}
          onClose={() => setDialog(null)}
          onSaved={() => {
            void reload();
            onChanged();
          }}
        />
      )}
    </div>
  );
}
