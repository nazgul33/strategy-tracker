import { describe, expect, test } from 'bun:test';
import type { DetectedDto, PendingFillDto } from './api';
import {
  feeIsDerived,
  patchRowValues,
  pendingEdits,
  pendingIssue,
  standingIssue,
  type RowValues,
} from './pendingvalues';

// costPpm 40 makes the derived fee 7 cents for 10 sh @ 178.40 (the `detected` snapshot below),
// 9 cents for 12 sh, 8 cents for 10 sh @ 200.00, and 14 cents for the legacy row's 10 sh @ 349.99.
function pendingRow(over: Partial<PendingFillDto> = {}): PendingFillDto {
  return {
    id: 1,
    runId: 1,
    captureId: null,
    bucketIdx: 0,
    side: 'buy',
    ticker: 'AAPL',
    shares: 10,
    price: '3499900',
    fee: null,
    filledOn: '2026-11-02',
    status: 'pending',
    createdAt: '2026-11-02T14:00:00Z',
    hasImage: true,
    costPpm: 40,
    heldBuckets: [],
    detected: null,
    ...over,
  };
}

const detected: DetectedDto = { side: 'buy', shares: 10, price: '1784000', filledOn: '2026-11-02', fee: 50 };
const feeless: DetectedDto = { ...detected, fee: null };
const missed: DetectedDto = { side: null, shares: null, price: null, filledOn: null, fee: null };
const row = (d: DetectedDto | null = detected) => pendingRow({ detected: d });
const same: RowValues = { side: 'buy', shares: '10', price: '178.40', filledOn: '2026-11-02', fee: '0.50', feeTouched: false };

describe('pendingIssue', () => {
  test('first missing field wins', () => {
    expect(pendingIssue(pendingRow({ ticker: '' }))).toEqual({ field: 'ticker' });
    expect(pendingIssue(pendingRow({ side: 'SELL' }))).toEqual({ field: 'side' });
    expect(pendingIssue(pendingRow({ shares: 0 }))).toEqual({ field: 'shares' });
    expect(pendingIssue(pendingRow({ price: '' }))).toEqual({ field: 'price' });
    expect(pendingIssue(pendingRow({ filledOn: '' }))).toEqual({ field: 'filledOn' });
  });

  test('complete row needs no fix', () => {
    expect(pendingIssue(pendingRow())).toEqual({ field: null });
    expect(pendingIssue(row())).toEqual({ field: null });
  });

  // Ingest stores the capture date in `filledOn` when vision read none, so the row's own date is
  // never empty; only the snapshot says it was missed.
  test('a date vision missed is an issue even though the row carries the substituted date', () => {
    const substituted = pendingRow({ filledOn: '2026-11-09', detected: { ...detected, filledOn: null } });
    expect(pendingIssue(substituted)).toEqual({ field: 'filledOn' });
  });

  test('a legacy row (no snapshot) cannot say its date was substituted, so its own date stands', () => {
    expect(pendingIssue(pendingRow({ filledOn: '2026-11-09', detected: null }))).toEqual({ field: null });
  });
});

describe('standingIssue', () => {
  const substituted = pendingRow({ filledOn: '2026-11-09', detected: { ...detected, filledOn: null } });
  const blankDate: RowValues = { ...same, filledOn: '' };

  test('a missed date stands while the field is blank and clears once it is filled in', () => {
    expect(standingIssue(substituted, blankDate)).toBe('filledOn');
    expect(standingIssue(substituted, { ...blankDate, filledOn: ' ' })).toBe('filledOn');
    expect(standingIssue(substituted, { ...blankDate, filledOn: '2026-11-09' })).toBeNull();
  });

  test('a row with nothing missing has no standing issue', () => {
    expect(standingIssue(row(), same)).toBeNull();
  });

  test('a missing ticker has no control, so it always stands', () => {
    expect(standingIssue(pendingRow({ ticker: '' }), same)).toBe('ticker');
  });
});

describe('pendingEdits', () => {
  test('returns [] when every value matches the detected snapshot', () => {
    expect(pendingEdits(row(), same)).toEqual([]);
  });

  test('names each field that differs', () => {
    expect(pendingEdits(row(), { ...same, side: 'sell' })).toEqual(['side']);
    expect(pendingEdits(row(), { ...same, shares: '11' })).toEqual(['shares']);
    expect(pendingEdits(row(), { ...same, price: '178.41' })).toEqual(['price']);
    expect(pendingEdits(row(), { ...same, filledOn: '2026-11-03' })).toEqual(['filledOn']);
    expect(pendingEdits(row(), { ...same, fee: '0.51' })).toEqual(['fee']);
    expect(
      pendingEdits(row(), { side: 'sell', shares: '11', price: '1', filledOn: '2026-11-03', fee: '9', feeTouched: true }),
    ).toEqual(['filledOn', 'side', 'shares', 'price', 'fee']);
  });

  test('treats a null detected value with a filled-in field as edited', () => {
    expect(pendingEdits(row(missed), same)).toEqual(['filledOn', 'side', 'shares', 'price', 'fee']);
    expect(pendingEdits(row({ ...detected, side: null }), same)).toEqual(['side']);
  });

  test('filling in the date vision missed is an edit', () => {
    const substituted = pendingRow({ filledOn: '2026-11-09', detected: { ...detected, filledOn: null } });
    expect(pendingEdits(substituted, { ...same, filledOn: '' })).toEqual([]);
    expect(pendingEdits(substituted, { ...same, filledOn: '2026-11-09' })).toEqual(['filledOn']);
  });

  describe('a fee vision did not read', () => {
    test('the fee the server derives for the current qty and price is unedited', () => {
      const fl = row(feeless);
      expect(pendingEdits(fl, { ...same, fee: '0.07' })).toEqual([]);
      expect(pendingEdits(fl, { ...same, fee: '0.070' })).toEqual([]);
      expect(pendingEdits(fl, { ...same, fee: '' })).toEqual([]);
      expect(pendingEdits(fl, { ...same, fee: '0.08' })).toEqual(['fee']);
    });

    test('the derivation follows the quantity and price as they stand now', () => {
      const fl = row(feeless);
      expect(pendingEdits(fl, { ...same, shares: '12', fee: '0.09' })).toEqual(['shares']);
      expect(pendingEdits(fl, { ...same, price: '200.00', fee: '0.08' })).toEqual(['price']);
    });

    // The review's two cases: the fee on screen must be the fee booked.
    test('a stale derived fee after a qty edit is an edit, so the typed value is sent, not recomputed away', () => {
      expect(pendingEdits(row(feeless), { ...same, shares: '12', fee: '0.07', feeTouched: true })).toEqual(['shares', 'fee']);
    });

    test('with qty or price unparsable nothing is derivable, so only a blank fee is unedited', () => {
      const fl = row(feeless);
      expect(pendingEdits(fl, { ...same, shares: '', fee: '' })).toEqual(['shares']);
      expect(pendingEdits(fl, { ...same, price: '', fee: '0.07' })).toEqual(['price', 'fee']);
    });
  });

  test('the derived fee does not excuse a fee when vision did read one', () => {
    expect(pendingEdits(row(), { ...same, fee: '0.07' })).toEqual(['fee']);
  });

  test('a blank field against a null detected value is unedited', () => {
    expect(pendingEdits(row(missed), { side: '', shares: '', price: ' ', filledOn: '', fee: '', feeTouched: false })).toEqual([]);
  });

  test('clearing a field vision did read counts as edited', () => {
    expect(pendingEdits(row(), { ...same, fee: '' })).toEqual(['fee']);
    expect(pendingEdits(row(), { ...same, price: '' })).toEqual(['price']);
    expect(pendingEdits(row(), { ...same, shares: '' })).toEqual(['shares']);
  });

  test('unparsable input differs from what vision read', () => {
    expect(pendingEdits(row(), { ...same, price: 'abc', shares: '1.5', fee: 'x' })).toEqual(['shares', 'price', 'fee']);
  });

  describe('a legacy row (detected null) is compared against the row itself', () => {
    const untouched: RowValues = { side: 'buy', shares: '10', price: '349.99', filledOn: '2026-11-02', fee: '0.14', feeTouched: false };

    test('its prefilled values are no edit, including the derived fee', () => {
      expect(pendingEdits(row(null), untouched)).toEqual([]);
    });

    test('names each field the operator changed', () => {
      expect(
        pendingEdits(row(null), { side: 'sell', shares: '99', price: '1', filledOn: '2020-01-01', fee: '9', feeTouched: true }),
      ).toEqual(['filledOn', 'side', 'shares', 'price', 'fee']);
      expect(pendingEdits(row(null), { ...untouched, shares: '11', fee: '0.15' })).toEqual(['shares']);
    });

    test('a field the row lacks counts as edited once filled in', () => {
      const blank = pendingRow({ detected: null, side: '', shares: 0, price: '', filledOn: '' });
      expect(pendingEdits(blank, untouched)).toEqual(['filledOn', 'side', 'shares', 'price']);
    });

    test('a stored fee is the baseline instead of the derived one', () => {
      const stored = pendingRow({ detected: null, fee: 50 });
      expect(pendingEdits(stored, { ...untouched, fee: '0.50' })).toEqual([]);
      expect(pendingEdits(stored, { ...untouched, fee: '' })).toEqual(['fee']);
    });
  });

  test('treats 178.4 and 178.40 as the same price', () => {
    expect(pendingEdits(row(), { ...same, price: '178.4' })).toEqual([]);
    expect(pendingEdits(row(), { ...same, price: '178.40' })).toEqual([]);
    expect(pendingEdits(row(), { ...same, price: '178.4000' })).toEqual([]);
    expect(pendingEdits(row(), { ...same, price: '178.401' })).toEqual(['price']);
  });

  test('treats comma-grouped "12,345.00" as the same price as 12345.00', () => {
    const d = { ...detected, price: '123450000' };
    expect(pendingEdits(row(d), { ...same, price: '12,345.00' })).toEqual([]);
    expect(pendingEdits(row(d), { ...same, price: '12,34.00' })).toEqual(['price']);
  });

  test('treats a fee of "0.00" against detected fee 0 as unedited', () => {
    const zero = row({ ...detected, fee: 0 });
    expect(pendingEdits(zero, { ...same, fee: '0.00' })).toEqual([]);
    expect(pendingEdits(zero, { ...same, fee: '0' })).toEqual([]);
    expect(pendingEdits(zero, { ...same, fee: '0.01' })).toEqual(['fee']);
  });

  test('treats shares with stray whitespace or a leading zero as the same count', () => {
    expect(pendingEdits(row(), { ...same, shares: ' 10 ' })).toEqual([]);
    expect(pendingEdits(row(), { ...same, shares: '010' })).toEqual([]);
  });
});

describe('patchRowValues', () => {
  const fl = row(feeless);
  const start: RowValues = { ...same, fee: '0.07' };

  test('a qty edit re-derives the untouched fee of a feeless capture', () => {
    expect(patchRowValues(fl, start, { shares: '12' })).toEqual({ ...start, shares: '12', fee: '0.09' });
  });

  test('a price edit re-derives it too', () => {
    expect(patchRowValues(fl, start, { price: '200.00' }).fee).toBe('0.08');
  });

  test('qty or price that do not parse blank the fee, and fixing them brings it back', () => {
    const broken = patchRowValues(fl, start, { shares: '' });
    expect(broken.fee).toBe('');
    expect(patchRowValues(fl, broken, { shares: '12' }).fee).toBe('0.09');
  });

  test('typing a fee marks it touched, and later qty or price edits leave it alone', () => {
    const typed = patchRowValues(fl, start, { fee: '0.07' });
    expect(typed.feeTouched).toBe(true);
    expect(patchRowValues(fl, typed, { shares: '12' })).toEqual({ ...typed, shares: '12' });
  });

  test('a fee equal to the derived one still counts as typed once the operator has typed it', () => {
    const typed = patchRowValues(fl, start, { fee: '0.07' });
    expect(patchRowValues(fl, typed, { price: '200.00' }).fee).toBe('0.07');
  });

  test('a fee vision read is never re-derived', () => {
    const read = { ...same };
    expect(patchRowValues(row(), read, { shares: '12' })).toEqual({ ...read, shares: '12' });
  });

  test('a legacy row follows the derived fee only when it stored none', () => {
    const noFee = row(null);
    expect(patchRowValues(noFee, { ...same, price: '349.99', fee: '0.14' }, { shares: '12' }).fee).toBe('0.17');
    const stored = pendingRow({ detected: null, fee: 50 });
    expect(patchRowValues(stored, { ...same, price: '349.99', fee: '0.50' }, { shares: '12' }).fee).toBe('0.50');
  });

  test('edits to other fields do not touch the fee', () => {
    expect(patchRowValues(fl, start, { side: 'sell' })).toEqual({ ...start, side: 'sell' });
  });

  // The invariant behind the whole fee design: what is on screen is what the server books.
  test('the displayed fee never differs from what a confirm would book', () => {
    let values = start;
    for (const patch of [{ shares: '12' }, { price: '200.00' }, { shares: '3' }, { price: '1.50' }]) {
      values = patchRowValues(fl, values, patch);
      expect(pendingEdits(fl, values)).not.toContain('fee');
    }
  });
});

describe('feeIsDerived', () => {
  const fl = row(feeless);

  test('a feeless capture holding exactly the derived fee is marked', () => {
    expect(feeIsDerived(fl, { ...same, fee: '0.07' })).toBe(true);
  });

  test('a typed fee that differs is not', () => {
    expect(feeIsDerived(fl, { ...same, fee: '0.09' })).toBe(false);
  });

  test('a stale derived fee is not, once qty has moved on', () => {
    expect(feeIsDerived(fl, { ...same, shares: '12', fee: '0.07', feeTouched: true })).toBe(false);
  });

  test('a blank fee shows nothing to mark', () => {
    expect(feeIsDerived(fl, { ...same, fee: '' })).toBe(false);
  });

  test('a fee vision read is never marked as derived', () => {
    expect(feeIsDerived(row(), same)).toBe(false);
    expect(feeIsDerived(row(), { ...same, fee: '0.07' })).toBe(false);
  });

  test('a legacy row is marked only when it stored no fee', () => {
    expect(feeIsDerived(row(null), { ...same, price: '349.99', fee: '0.14' })).toBe(true);
    expect(feeIsDerived(pendingRow({ detected: null, fee: 14 }), { ...same, price: '349.99', fee: '0.14' })).toBe(false);
  });
});
