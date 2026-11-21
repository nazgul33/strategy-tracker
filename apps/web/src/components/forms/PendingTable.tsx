import { useState } from 'react';
import { ApiError, api, usdFeeOrNull, usdOrNull, usdToCents, type PendingFillDto, type PendingOverrides } from '../../api';
import { autoFeeUsd } from '../../autofee';
import { costPercentText } from '../../format';
import { useT } from '../../i18n';
import { patchRowValues, pendingEdits, standingIssue, type RowValues } from '../../pendingvalues';
import { useAsync } from '../hooks';
import { EmptyNote, TableWrap, Th } from '../ui';
import { DefaultFeePrompt } from './DefaultFeePrompt';
import { KeepImagePrompt } from './KeepImagePrompt';
import { PendingReviewDialog } from './PendingReviewDialog';
import { PendingRow, initialRowValues } from './PendingRow';

// An action waiting on a prompt: first the default-fee popup (a blank fee on
// confirm), then the keep/discard prompt. `values` is what the row held when the
// button was pressed; the overrides, both prompts and the post all follow it.
interface Decision {
  row: PendingFillDto;
  values: RowValues;
  action: 'confirm' | 'reject';
  overrides: PendingOverrides | undefined;
  stage: 'fee' | 'keep';
}

// Unrecognized screenshot fills. Every field is one control pre-filled with what
// vision detected; confirm sends only the fields that differ from that
// (pendingEdits), so an untouched confirm posts no overrides. A 409 on confirm is
// either ticker-mismatch (integrity guard: the pending row's ticker ≠ the run's
// ticker — the untouched row stays visible for rejection) or the row was
// already handled elsewhere.
export function PendingTable({ runId }: { runId?: number }) {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => api.listPending(), []);
  const [edited, setEdited] = useState<Record<number, RowValues>>({});
  const [reviewId, setReviewId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);

  const visible = (data ?? []).filter((r) => runId === undefined || r.runId === runId);
  const reviewing = visible.find((r) => r.id === reviewId);

  const valuesFor = (r: PendingFillDto) => edited[r.id] ?? initialRowValues(r);
  const patchValues = (r: PendingFillDto, patch: Partial<RowValues>) =>
    setEdited((prev) => ({ ...prev, [r.id]: patchRowValues(r, prev[r.id] ?? initialRowValues(r), patch) }));
  const setValues = (r: PendingFillDto, values: RowValues) => setEdited((prev) => ({ ...prev, [r.id]: values }));

  const buildOverrides = (r: PendingFillDto, v: RowValues): PendingOverrides | undefined => {
    const invalid = () => new Error(t('pendingInvalidOverride'));
    // A field vision missed stays unbooked until it is filled in: left blank it reads as
    // unedited, and the server would substitute its own value (the capture date for a date).
    if (standingIssue(r, v) !== null && standingIssue(r, v) !== 'ticker') throw new Error(t('pendingNeedsOverride'));
    const body: PendingOverrides = {};
    for (const field of pendingEdits(r, v)) {
      if (field === 'side') {
        if (v.side !== 'buy' && v.side !== 'sell') throw invalid();
        body.side = v.side;
      } else if (field === 'shares') {
        // Digits only: Number() would read "1e1" as 10 and "0x10" as 16.
        const n = /^\d+$/.test(v.shares.trim()) ? Number(v.shares) : NaN;
        if (!Number.isInteger(n) || n <= 0) throw invalid();
        body.shares = n;
      } else if (field === 'price') {
        const price = usdOrNull(v.price);
        if (price === null) throw invalid();
        body.price = price;
      } else if (field === 'filledOn') {
        if (v.filledOn.trim() === '') throw invalid();
        body.filledOn = v.filledOn;
      } else if (v.fee.trim() === '') {
        body.feeCents = null;
      } else {
        const fee = usdFeeOrNull(v.fee);
        const cents = fee === null ? null : usdToCents(fee);
        if (cents === null) throw invalid();
        body.feeCents = cents;
      }
    }
    return Object.keys(body).length > 0 ? body : undefined;
  };

  const reportError = async (err: unknown) => {
    if (err instanceof ApiError && err.code === 'ticker-mismatch') {
      // The row is untouched — do NOT reload; it must stay visible so the
      // user can reject it.
      setActionError(t('pendingTickerMismatch'));
    } else if (err instanceof ApiError && err.status === 409) {
      setActionError(t('pendingAlreadyHandled'));
      await reload();
    } else if (err instanceof ApiError) {
      // Same rule as FillDialog: known fillErr.* codes read localized, the
      // rest fall back to the raw server code (ApiError.message).
      const key = `fillErr.${err.code}`;
      const msg = t(key);
      setActionError(msg === key ? err.message : msg);
    } else {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const submit = async ({ row, action, overrides }: Decision, keepImage?: boolean) => {
    setBusyId(row.id);
    try {
      const res =
        action === 'confirm'
          ? await api.confirmPending(row.id, overrides, keepImage)
          : await api.rejectPending(row.id, keepImage);
      await reload();
      if (keepImage === true && !res.archived) setActionError(t('keepImageNotKept'));
    } catch (err) {
      await reportError(err);
    } finally {
      setBusyId(null);
    }
  };

  // A vision misread is only plausible when there is a screenshot to keep, the
  // row really was a vision reading (a legacy row has no snapshot to be wrong
  // against), and the operator either corrected it or threw it out.
  const asksAboutImage = ({ row, values, action }: Decision) =>
    row.hasImage && row.detected !== null && (action === 'reject' || pendingEdits(row, values).length > 0);

  const act = async (r: PendingFillDto, action: 'confirm' | 'reject') => {
    setActionError(null);
    const values = valuesFor(r);
    let overrides: PendingOverrides | undefined;
    try {
      if (action === 'confirm') overrides = buildOverrides(r, values);
    } catch (err) {
      await reportError(err);
      return;
    }
    const next: Decision = { row: r, values, action, overrides, stage: 'keep' };
    if (action === 'confirm' && values.fee.trim() === '' && autoFeeUsd(values.shares, values.price, r.costPpm) !== '') {
      setDecision({ ...next, stage: 'fee' });
    } else if (asksAboutImage(next)) setDecision(next);
    else await submit(next);
  };

  const acceptDefaultFee = (current: Decision) => {
    if (asksAboutImage(current)) {
      setDecision({ ...current, stage: 'keep' });
    } else {
      setDecision(null);
      void submit(current);
    }
  };

  if (loading) return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-destructive">{error}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
      {visible.length === 0 ? (
        <EmptyNote>{t('pendingEmpty')}</EmptyNote>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>{t('pendingColDate')}</Th>
              <Th>{t('pendingColTicker')}</Th>
              <Th>{t('pendingColSide')}</Th>
              <Th className="text-right">{t('pendingColQty')}</Th>
              <Th className="text-right">{t('pendingColPrice')}</Th>
              <Th className="text-right">{t('pendingColFee')}</Th>
              <Th>
                <span className="sr-only">{t('pendingColScreenshot')}</span>
              </Th>
              <Th>{t('pendingColDetected')}</Th>
              <Th className="sticky right-0 bg-card">{t('pendingColActions')}</Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <PendingRow
                key={r.id}
                row={r}
                values={valuesFor(r)}
                onChange={(patch) => patchValues(r, patch)}
                onOpenSideBySide={() => setReviewId(r.id)}
                onConfirm={() => void act(r, 'confirm')}
                onReject={() => void act(r, 'reject')}
                busy={busyId === r.id}
              />
            ))}
          </tbody>
        </TableWrap>
      )}
      {decision?.stage === 'fee' && (
        <DefaultFeePrompt
          rate={costPercentText(decision.row.costPpm)}
          price={decision.values.price}
          shares={decision.values.shares}
          fee={autoFeeUsd(decision.values.shares, decision.values.price, decision.row.costPpm)}
          onUse={() => acceptDefaultFee(decision)}
          onBack={() => setDecision(null)}
        />
      )}
      {decision?.stage === 'keep' && (
        <KeepImagePrompt
          action={decision.action}
          onDecide={(keep) => {
            setDecision(null);
            void submit(decision, keep);
          }}
          onDismiss={() => setDecision(null)}
        />
      )}
      {reviewing && (
        <PendingReviewDialog
          row={reviewing}
          values={valuesFor(reviewing)}
          onCancel={() => setReviewId(null)}
          onDone={(values) => {
            setValues(reviewing, values);
            setReviewId(null);
          }}
        />
      )}
    </div>
  );
}
