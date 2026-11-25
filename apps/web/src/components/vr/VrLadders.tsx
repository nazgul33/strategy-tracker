// The buy instruction, a waiting note, or the two ladder tables of the current cycle.
import type { VrRunDetailDto, VrRungDto } from '../../api.vr.types';
import { centsUsd, isoDate, priceUsd } from '../../format';
import { useT } from '../../i18n';
import { EmptyNote, TableWrap, Td, Th } from '../ui';

function LadderSide({ testId, title, rungs, total }: { testId: string; title: string; rungs: VrRungDto[]; total: number }) {
  const t = useT();
  return (
    <section data-testid={testId}>
      <h3 className="mb-2 text-sm font-semibold">
        {title} · {t('vr.rungsLeft', { left: rungs.length, total })}
      </h3>
      {rungs.length === 0 ? (
        <EmptyNote>{t('vr.ladderEmpty')}</EmptyNote>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th className="text-right">{t('vr.colShares')}</Th>
              <Th className="text-right">{t('fillColPrice')}</Th>
            </tr>
          </thead>
          <tbody>
            {rungs.map((r, i) => (
              <tr key={i}>
                <Td className="text-right tabular-nums">{r.shares}</Td>
                <Td className="text-right tabular-nums">{priceUsd(r.price)}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </section>
  );
}

export function VrLadders({ detail }: { detail: VrRunDetailDto }) {
  const t = useT();
  const { buyInstruction, lastClose, books, cycle, ladder } = detail;

  if (buyInstruction !== null && lastClose !== null) {
    return (
      <p data-testid="vrBuyInstruction" className="text-sm">
        {t('vr.buyInstruction', {
          shares: buyInstruction.shares,
          amount: centsUsd(buyInstruction.targetCents),
          close: priceUsd(lastClose.close),
          date: isoDate(lastClose.date),
        })}
      </p>
    );
  }
  if (books.shares === 0) {
    return (
      <p data-testid="vrBuyPending" className="text-sm text-muted-foreground">
        {t('vr.buyInstructionPending')}
      </p>
    );
  }
  if (cycle === null || cycle.openShares === 0) {
    return (
      <p data-testid="vrLadderNextCycle" className="text-sm text-muted-foreground">
        {t('vr.ladderNextCycle')}
      </p>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <LadderSide testId="vrBuyLadder" title={t('vr.buyLadder')} rungs={ladder.buy} total={ladder.buyTotal} />
      <LadderSide testId="vrSellLadder" title={t('vr.sellLadder')} rungs={ladder.sell} total={ladder.sellTotal} />
    </div>
  );
}
