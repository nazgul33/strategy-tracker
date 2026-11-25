// Cycles tab: one row per cycle, newest first as the server sends them.
import { vrApi } from '../../api.vr';
import { centsUsd, isoDate, priceUsd } from '../../format';
import { useT } from '../../i18n';
import { useAsync } from '../hooks';
import { Badge, EmptyNote, Spinner, TableWrap, Td, Th } from '../ui';
import { VrPanelState } from './VrPanelState';

const NUM = 'text-right tabular-nums';

export function VrCyclesPanel({ runId }: { runId: number }) {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => vrApi.listCycles(runId), [runId]);
  if (loading) return <Spinner />;
  if (error) return <VrPanelState error={error} onRetry={() => void reload()} />;
  const cycles = data ?? [];
  if (cycles.length === 0) return <EmptyNote>{t('vr.noCycle')}</EmptyNote>;
  return (
    <TableWrap>
      <thead>
        <tr>
          <Th className="text-right">{t('vr.colCycle')}</Th>
          <Th>{t('vr.colDates')}</Th>
          <Th className="text-right">{t('vr.colV')}</Th>
          <Th className="text-right">{t('vr.colBand')}</Th>
          <Th className="text-right">{t('vr.colOpenShares')}</Th>
          <Th className="text-right">{t('vr.colOpenPool')}</Th>
          <Th className="text-right">{t('vr.colBudget')}</Th>
          <Th className="text-right">{t('vr.colClose')}</Th>
          <Th className="text-right">{t('vr.colE')}</Th>
          <Th className="text-right">{t('vr.colDeposit')}</Th>
        </tr>
      </thead>
      <tbody>
        {cycles.map((c) => (
          <tr key={c.id}>
            <Td className={NUM}>{c.seq}</Td>
            <Td className="whitespace-nowrap">{`${isoDate(c.startDate)} – ${isoDate(c.endDate)}`}</Td>
            <Td className={NUM}>
              {centsUsd(c.vCents)}
              {c.vKept && (
                <>
                  {' '}
                  <span title={t('vr.vKeptHint')}>
                    <Badge tone="warning">{t('vr.vKept')}</Badge>
                  </span>
                </>
              )}
            </Td>
            <Td className={`${NUM} whitespace-nowrap`}>{`${centsUsd(c.bandMinCents)} – ${centsUsd(c.bandMaxCents)}`}</Td>
            <Td className={NUM}>{c.openShares}</Td>
            <Td className={NUM}>{centsUsd(c.openPoolCents)}</Td>
            <Td className={NUM}>{centsUsd(c.buyBudgetCents)}</Td>
            <Td className={NUM}>{priceUsd(c.prevClose)}</Td>
            <Td className={NUM}>{centsUsd(c.evalCents)}</Td>
            <Td className={NUM}>{centsUsd(c.depositCents)}</Td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}
