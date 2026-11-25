// Fills tab of a VR run: the fills newest first, with add, edit and delete.
import { useState } from 'react';
import { vrApi } from '../../api.vr';
import type { VrFillDto } from '../../api.vr.types';
import { centsUsd, isoDate, priceUsd } from '../../format';
import { useT } from '../../i18n';
import { useAsync } from '../hooks';
import { Badge, Button, EmptyNote, Spinner, TableWrap, Td, Th } from '../ui';
import { VrFillDialog } from './VrFillDialog';
import { VrPanelState } from './VrPanelState';

export interface VrPanelProps {
  runId: number;
  costPpm: number;
  today: string;
  onChanged: () => void;
}

const NUM = 'text-right tabular-nums';

/** The date of an entry, marked when it falls before the current cycle. */
export function VrEntryDate({ date, earlier }: { date: string; earlier: boolean }) {
  const t = useT();
  return (
    <>
      {isoDate(date)}
      {earlier && (
        <>
          {' '}
          <span title={t('vr.earlierCycleHint')}>
            <Badge tone="warning">{t('vr.earlierCycle')}</Badge>
          </span>
        </>
      )}
    </>
  );
}

export function VrFillsPanel({ runId, costPpm, today, onChanged }: VrPanelProps) {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => vrApi.listFills(runId), [runId]);
  const [dialog, setDialog] = useState<{ fill?: VrFillDto; deleting?: boolean } | null>(null);

  const body = () => {
    if (loading) return <Spinner />;
    if (error) return <VrPanelState error={error} onRetry={() => void reload()} />;
    const fills = data ?? [];
    return (
      <>
        <div className="mb-3 flex justify-end">
          <Button variant="primary" data-testid="vrAddFill" onClick={() => setDialog({})}>
            {t('dialog.addFill')}
          </Button>
        </div>
        {fills.length === 0 ? (
          <EmptyNote>{t('fillEmpty')}</EmptyNote>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('vr.colDate')}</Th>
                <Th>{t('fillColSide')}</Th>
                <Th className="text-right">{t('vr.colShares')}</Th>
                <Th className="text-right">{t('fillColPrice')}</Th>
                <Th className="text-right">{t('fillColFee')}</Th>
                <Th className="text-right">{t('fillColActions')}</Th>
              </tr>
            </thead>
            <tbody>
              {fills.map((f) => (
                <tr key={f.id}>
                  <Td className="whitespace-nowrap tabular-nums">
                    <VrEntryDate date={f.filledOn} earlier={f.beforeCycle} />
                  </Td>
                  <Td>
                    <Badge tone={f.side === 'buy' ? 'info' : 'primary'}>
                      {t(f.side === 'buy' ? 'orderSideBuy' : 'orderSideSell')}
                    </Badge>
                  </Td>
                  <Td className={NUM}>{f.shares}</Td>
                  <Td className={NUM}>{priceUsd(f.price)}</Td>
                  <Td className={NUM}>{centsUsd(f.fee)}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button data-testid={`vrFillEdit-${f.id}`} onClick={() => setDialog({ fill: f })}>
                        {t('fillEdit')}
                      </Button>
                      <Button data-testid={`vrFillDelete-${f.id}`} onClick={() => setDialog({ fill: f, deleting: true })}>
                        {t('dialog.delete')}
                      </Button>
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
    <div data-testid="vrFillsPanel" data-run-id={runId}>
      {body()}
      {dialog && (
        <VrFillDialog
          runId={runId}
          costPpm={costPpm}
          today={today}
          fill={dialog.fill}
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
