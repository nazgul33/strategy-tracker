import { t } from '@st/telegram/i18n';
import type { Lang } from '@st/telegram/i18n';

import type { PendingFillRow } from '../domain/booking';

// A row the operator must fix in the web Pending view (a substituted or future date, a bucket
// to choose) is sent without Yes/No buttons, each reason on its own line.
export function pendingMessage(row: PendingFillRow, lang: Lang): { text: string; buttons: boolean } {
  const lines = [
    t('capture-booked', lang, { ticker: row.ticker, side: row.side, shares: row.shares, price: row.price, date: row.filledOn }),
  ];
  if (row.detectedFilledOn === null) lines.push(t('capture-date-substituted', lang, { date: row.filledOn }));
  if (row.dateAfterToday) lines.push(t('capture-date-after-today', lang, { date: row.filledOn }));
  if (row.needsBucket) lines.push(t('capture-needs-bucket', lang));
  return { text: lines.join('\n'), buttons: lines.length === 1 };
}
