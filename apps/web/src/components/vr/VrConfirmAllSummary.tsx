// What Confirm all did: how many rows were booked, each refused row with its reason, and the rows left waiting.
import { ApiError, type ApiErrorCode } from '../../api';
import type { VrConfirmAllResult, VrPendingDto } from '../../api.vr.types';
import { errorText } from '../../errortext';
import { isoDate } from '../../format';
import { useT } from '../../i18n';
import { readPriceUsd } from './vrText';

/** `rows` is the list as it was before Confirm all: the server names a refused row by id only. */
export function VrConfirmAllSummary({ result, rows }: { result: VrConfirmAllResult; rows: VrPendingDto[] }) {
  const t = useT();

  const codeText = (code: string): string =>
    errorText(new ApiError(code === 'vr-not-pending' ? 409 : 422, code as ApiErrorCode), t, 'vrErr');

  const fillText = (id: number): string => {
    const row = rows.find((r) => r.id === id);
    if (!row) return `#${id}`;
    return t('vr.pendingFillLine', {
      side: t(row.side === 'buy' ? 'orderSideBuy' : 'orderSideSell'),
      shares: row.shares,
      price: readPriceUsd(row.price),
      date: isoDate(row.filledOn),
    });
  };

  return (
    <div role="status" data-testid="vrConfirmAllSummary" className="mb-3 rounded-md bg-muted px-2 py-1.5 text-sm">
      <p data-testid="vrConfirmAllBooked">{t('vr.confirmAllBooked', { n: result.confirmed })}</p>
      {result.refused.length > 0 && (
        <>
          <p>{t('vr.confirmAllRefusedHead', { n: result.refused.length })}</p>
          <ul data-testid="vrConfirmAllRefused">
            {result.refused.map((r) => (
              <li key={r.id}>{t('vr.confirmAllRefusedRow', { fill: fillText(r.id), reason: codeText(r.error) })}</li>
            ))}
          </ul>
        </>
      )}
      <p data-testid="vrConfirmAllLeftDuplicates">{t('vr.confirmAllLeftDuplicates', { n: result.skippedDuplicates })}</p>
      <p data-testid="vrConfirmAllLeftUndated">{t('vr.confirmAllLeftUndated', { n: result.skippedUndated })}</p>
    </div>
  );
}
