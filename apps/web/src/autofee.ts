import { feeCents, parseUsd } from '@st/core/money';
import { ungroupUsd, usdFeeOrNull, usdOrNull } from './api';
import { centsToUsdText } from './format';

// Fee text the server would book for these inputs (same feeCents half-up math
// as booking.ts), or '' when the run has no usable cost, price/shares are
// invalid, or the fee would not be accepted by the fee field.
export function autoFeeUsd(shares: string, price: string, costPpm: number | undefined): string {
  if (costPpm === undefined || !Number.isInteger(costPpm) || costPpm < 0) return '';
  const priceUsd = usdOrNull(ungroupUsd(price));
  if (priceUsd === null || !Number.isInteger(Number(shares)) || Number(shares) <= 0) return '';
  const text = centsToUsdText(feeCents(parseUsd(priceUsd), Number(shares), costPpm));
  return usdFeeOrNull(text) === null ? '' : text;
}
