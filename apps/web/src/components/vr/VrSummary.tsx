// The cycle line and the stats of a VR run; a warning when the Pool has gone negative.
import type { VrRunDetailDto } from '../../api.vr.types';
import { centsUsd, isoDate, priceUsd, signedCentsUsd } from '../../format';
import { useT } from '../../i18n';
import { pnlBadgeTone, toneFor } from '../../viewmodels';
import { Stat } from '../ui';
import { formulaLabelKey } from './vrText';

export function VrSummary({ detail }: { detail: VrRunDetailDto }) {
  const t = useT();
  const { cycle: c, books: b } = detail;
  const inputs = c ?? detail.run.settings;

  return (
    <div data-testid="vrSummary" className="space-y-3">
      <p data-testid="vrCycleLine" className="text-sm text-muted-foreground">
        {c === null
          ? t('vr.noCycle')
          : t('vr.cycleLine', {
              seq: c.seq,
              start: isoDate(c.startDate),
              end: isoDate(c.endDate),
              next: isoDate(c.nextStart),
            })}
      </p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Stat label={t('vr.colV')} value={centsUsd(c?.vCents ?? null)} />
        <Stat
          label={t('vr.colBand')}
          value={c === null ? '—' : `${centsUsd(c.bandMinCents)} – ${centsUsd(c.bandMaxCents)}`}
        />
        <Stat label={t('vr.statG')} value={`${inputs.g} · ${t(formulaLabelKey(inputs.formula))}`} />
        <Stat label={t('vr.colShares')} value={b.shares} />
        <Stat label={t('vr.colPool')} value={centsUsd(b.poolCents)} tone={b.poolCents < 0 ? 'warning' : 'neutral'} />
        <Stat
          label={t('vr.budgetLeft')}
          value={centsUsd(detail.budgetLeftCents)}
          sub={c === null ? undefined : t('vr.budgetOf', { total: centsUsd(c.buyBudgetCents) })}
        />
        <Stat label={t('vr.colValue')} value={centsUsd(b.valueCents)} />
        <Stat label={t('vr.netInvested')} value={centsUsd(b.netInvestedCents)} />
        <Stat
          label={t('vr.profit')}
          value={signedCentsUsd(b.profitCents)}
          tone={pnlBadgeTone(toneFor(b.profitCents))}
        />
        <Stat label={t('vr.avgCost')} value={priceUsd(b.avgCost)} />
      </div>
      {b.poolCents < 0 && (
        <div
          role="status"
          data-testid="vrPoolNegative"
          className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {t('vr.poolNegative')}
        </div>
      )}
    </div>
  );
}
