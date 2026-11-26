// The client checks of a VR fill, shared by the fill dialog and the waiting-fill dialog so the two stay in step.
import type { VrFillInput, VrSide } from '../../api.vr.types';
import type { Translate } from '../../errortext';
import { ungroupUsd, usdFeeOrNull, usdOrNull } from '../../usd';

const MAX_SHARES = 2_147_483_647;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface VrFillText {
  side: VrSide;
  shares: string;
  price: string;
  fee: string;
  filledOn: string;
}

/** The checked values (`fee` is undefined when the field is blank), or the worded message of the first failed check. */
export function vrFillChecks(t: Translate, f: VrFillText): { value: VrFillInput } | { error: string } {
  const price = usdOrNull(ungroupUsd(f.price));
  if (price === null) return { error: t('manualInvalidPrice') };
  const shares = Number(f.shares.trim());
  if (!/^\d+$/.test(f.shares.trim()) || shares <= 0) return { error: t('manualInvalidQty') };
  if (shares > MAX_SHARES) return { error: t('vr.invalidSharesLarge') };
  const fee = f.fee.trim() === '' ? undefined : usdFeeOrNull(f.fee);
  if (fee === null) return { error: t('manualInvalidFee') };
  if (!ISO_DATE.test(f.filledOn)) return { error: t('manualInvalidDate') };
  return { value: { side: f.side, shares, price, fee, filledOn: f.filledOn } };
}
