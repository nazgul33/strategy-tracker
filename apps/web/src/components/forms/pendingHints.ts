import { feeIsDerived, fieldEditState, type RowField, type RowValues } from '../../pendingvalues';
import type { PendingFillDto } from '../../api';

export interface EditHint {
  state: 'changed' | 'filled' | 'erased' | 'auto';
  /** Catalog key of the hint text. */
  key: string;
  /** Classes that mark the control without resting on colour alone. */
  look: string;
}

const EDITED_LOOK = 'ring-1 ring-inset ring-primary';
const ERASED_LOOK = 'border-dashed border-warning';

/** The hint a pending-row control carries, or null when it has nothing to say. */
export function editHint(row: PendingFillDto, values: RowValues, field: RowField): EditHint | null {
  const state = fieldEditState(row, values, field);
  if (state === 'changed') return { state, key: 'pendingFieldChanged', look: EDITED_LOOK };
  if (state === 'filled') return { state, key: 'pendingFieldFilled', look: EDITED_LOOK };
  if (state === 'erased') {
    return { state, key: field === 'fee' ? 'pendingFeeErased' : 'pendingFieldErased', look: ERASED_LOOK };
  }
  if (field === 'fee' && feeIsDerived(row, values)) return { state: 'auto', key: 'pendingFeeAutoHint', look: '' };
  return null;
}
