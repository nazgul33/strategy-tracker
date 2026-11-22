import { parseUsd } from '@st/core/money';
import { ungroupUsd, usdToCents, type DetectedDto, type PendingFillDto } from './api';
import { autoFeeUsd } from './autofee';

/** A field `confirmPendingFill` needs that the row may lack. */
export type MissedField = 'ticker' | 'side' | 'shares' | 'price' | 'filledOn';

export interface PendingIssue {
  /** Field the user must fix before confirming; `null` when nothing is missing. */
  field: MissedField | null;
}

/**
 * Every field `confirmPendingFill` needs present (on the row or as an override),
 * in the order the operator meets them; surfacing them turns a server 400 into an
 * actionable hint. The trade date is read from the vision snapshot as well as the
 * row: ingest substitutes the capture date when vision found none, so the row's
 * own `filledOn` is never empty and would hide a date the operator has not seen.
 */
export function missingFields(row: PendingFillDto): MissedField[] {
  const missed: MissedField[] = [];
  if (!row.ticker) missed.push('ticker');
  if (row.side !== 'buy' && row.side !== 'sell') missed.push('side');
  if (!Number.isInteger(row.shares) || row.shares <= 0) missed.push('shares');
  if (!row.price) missed.push('price');
  if (!row.filledOn || row.detected?.filledOn === null) missed.push('filledOn');
  return missed;
}

/** The first missing field; see `missingFields`. */
export function pendingIssue(row: PendingFillDto): PendingIssue {
  return { field: missingFields(row)[0] ?? null };
}

/** What the operator currently has in each editable field of a pending row. */
export interface RowValues {
  filledOn: string;
  side: string;
  shares: string;
  price: string;
  fee: string;
  /** The operator has typed in the fee field; until then it follows qty and price. */
  feeTouched: boolean;
}

/** A field with a control of its own, as opposed to the flag that rides along. */
export type RowField = Exclude<keyof RowValues, 'feeTouched'>;

/**
 * The issues still standing for a row: a missed field only stands while the
 * operator has not filled it in. `ticker` has no control, so it never clears.
 */
export function standingIssues(row: PendingFillDto, values: RowValues): MissedField[] {
  return missingFields(row).filter((field) => field === 'ticker' || values[field].trim() === '');
}

// What vision read for the fee: the snapshot's, or the row's own for a row
// that predates the snapshot. null = nothing was read, so the server derives it.
function readFee(row: PendingFillDto): number | null {
  return row.detected ? row.detected.fee : row.fee;
}

// The fee the server books for these values when the confirm carries no fee,
// in cents; null while shares or price do not parse.
function derivedFeeCents(row: PendingFillDto, values: RowValues): number | null {
  const text = autoFeeUsd(values.shares, values.price, row.costPpm);
  return text === '' ? null : usdToCents(text);
}

/**
 * Applies an edit to a row's values. While the fee is untouched and vision read
 * none, a qty or price edit re-derives it (the `FillDialog` auto-fee pattern),
 * so the fee on screen is the one the server will book. Typing in the fee field
 * ends that for good.
 */
export function patchRowValues(row: PendingFillDto, prev: RowValues, patch: Partial<RowValues>): RowValues {
  const next = { ...prev, ...patch };
  if (patch.fee !== undefined && patch.feeTouched === undefined) next.feeTouched = true;
  const inputsChanged = patch.shares !== undefined || patch.price !== undefined;
  if (inputsChanged && patch.fee === undefined && !next.feeTouched && readFee(row) === null) {
    next.fee = autoFeeUsd(next.shares, next.price, row.costPpm);
  }
  return next;
}

/** The fee shown is the derived one (feeless capture, field holds exactly what the server would book). */
export function feeIsDerived(row: PendingFillDto, values: RowValues): boolean {
  if (readFee(row) !== null || values.fee.trim() === '') return false;
  return sameFee(null, values.fee, derivedFeeCents(row, values));
}

function sameShares(detected: number | null, value: string): boolean {
  const s = value.trim();
  if (detected === null || s === '') return detected === null && s === '';
  return /^\d+$/.test(s) && Number(s) === detected;
}

// Compared as myriadths, never as display strings: "178.4" and "178.40" are one price.
// A well-formed grouped price ("1,178.40") is read as its plain number here and in
// `buildOverrides`, which sends it ungrouped.
function samePrice(detected: string | null, value: string): boolean {
  const s = ungroupUsd(value);
  if (detected === null || s === '') return detected === null && s === '';
  try {
    return parseUsd(s) === BigInt(detected);
  } catch {
    return false;
  }
}

// Compared as integer cents. A cleared field is an edit when vision read a fee:
// it asks the server to recompute (`feeCents: null`). When vision read no fee the
// server derives one itself, so blank — or exactly the fee it would derive for the
// quantity and price as they stand now (`derivedCents`) — is not an edit. Typing
// any other amount is, even one that equals what the derivation gave earlier.
function sameFee(detected: number | null, value: string, derivedCents: number | null): boolean {
  const s = value.trim();
  if (detected === null) return s === '' || (derivedCents !== null && usdToCents(s) === derivedCents);
  return s !== '' && usdToCents(s) === detected;
}

// What each field is compared against; a row that predates the snapshot stands in for itself.
function snapshotFor(row: PendingFillDto): DetectedDto {
  return (
    row.detected ?? {
      side: row.side || null,
      shares: row.shares > 0 ? row.shares : null,
      price: row.price || null,
      filledOn: row.filledOn || null,
      fee: row.fee,
    }
  );
}

/**
 * What vision read per field; `null` = it read nothing there. A row that predates
 * the snapshot has no such record, so each field stands in with its own value.
 * A field whose own value is empty or unusable (a side that is not buy/sell, an
 * empty price, a null fee) still reads as `null`, so filling it in reads as
 * "filled in"; a shares of 0 or an empty date stand in as they are, so editing
 * them reads as "changed".
 */
export function detectedFor(row: PendingFillDto): Record<RowField, string | number | null> {
  const d = row.detected;
  if (!d) {
    return {
      filledOn: row.filledOn,
      side: row.side === 'buy' || row.side === 'sell' ? row.side : null,
      shares: row.shares,
      price: row.price || null,
      fee: readFee(row),
    };
  }
  return { filledOn: d.filledOn, side: d.side || null, shares: d.shares, price: d.price || null, fee: readFee(row) };
}

/**
 * Fields whose current value differs from what vision detected, in `RowValues`
 * order. Only these belong in a confirm's overrides, so an unchanged field is
 * omitted from the request, never sent as null. `detected: null` (a row that
 * predates the snapshot) is compared against the row's own values, so an old
 * row can still be corrected; this says what to send, not whether the operator
 * corrected vision (callers gate that on `row.detected`). A null field in the
 * snapshot means vision missed it, so any filled-in value counts as edited
 * (except a fee equal to the one the server derives for the current qty and price).
 */
export function pendingEdits(row: PendingFillDto, values: RowValues): RowField[] {
  const d = snapshotFor(row);
  const edited: RowField[] = [];
  const text = (detected: string | null, value: string) => (detected ?? '') === value.trim();
  if (!text(d.filledOn, values.filledOn)) edited.push('filledOn');
  if (!text(d.side, values.side)) edited.push('side');
  if (!sameShares(d.shares, values.shares)) edited.push('shares');
  if (!samePrice(d.price, values.price)) edited.push('price');
  if (!sameFee(d.fee, values.fee, derivedFeeCents(row, values))) edited.push('fee');
  return edited;
}

/**
 * How a control differs from what vision read, for the hint on it. `erased`: the
 * field is blank though a value was read (or, for the fee, one is derivable, which
 * covers a feeless row whose prefilled derived fee was cleared). `filled`: vision
 * read nothing there and the operator supplied a value. `changed`: any other edit.
 * A field the standing issues name gets no hint; its own warning border stands
 * until it is filled in.
 */
export function fieldEditState(
  row: PendingFillDto,
  values: RowValues,
  field: RowField,
): 'changed' | 'filled' | 'erased' | null {
  if ((standingIssues(row, values) as readonly string[]).includes(field)) return null;
  if (values[field].trim() === '') {
    const derivable = field === 'fee' && autoFeeUsd(values.shares, values.price, row.costPpm) !== '';
    if (snapshotFor(row)[field] !== null || derivable) return 'erased';
  }
  if (!pendingEdits(row, values).includes(field)) return null;
  return detectedFor(row)[field] === null ? 'filled' : 'changed';
}
