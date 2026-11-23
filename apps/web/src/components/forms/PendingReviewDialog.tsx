import { useState } from 'react';
import type { PendingFillDto } from '../../api';
import { useT } from '../../i18n';
import { autoFeeUsd } from '../../autofee';
import { patchRowValues, standingIssues, type RowField, type RowValues } from '../../pendingvalues';
import { ScreenshotLink } from '../ScreenshotLink';
import { Button, Field, Input, Modal, Select } from '../ui';
import { editHint } from './pendingHints';

interface PendingReviewDialogProps {
  row: PendingFillDto;
  values: RowValues;
  onCancel: () => void;
  onDone: (values: RowValues) => void;
}

// The broker's screenshot beside the values about to be booked, so a price can
// be read against the image at full size. Edits stay local until Done, which
// hands them back to the row; nothing is booked here — Confirm on the row does that.
export function PendingReviewDialog({ row, values, onCancel, onDone }: PendingReviewDialogProps) {
  const t = useT();
  const [draft, setDraft] = useState<RowValues>(values);
  const set = (patch: Partial<RowValues>) => setDraft((prev) => patchRowValues(row, prev, patch));
  // The hint text beside a field and the marks on its control, the same as on the row;
  // there is room here, so the text is always visible rather than shown on focus.
  const issues: readonly string[] = standingIssues(row, draft);
  const hintFor = (f: RowField) => {
    const h = editHint(row, draft, f);
    const text = h ? t(h.key) : undefined;
    const base = issues.includes(f) ? 'w-full border-warning' : 'w-full';
    const control = h
      ? { className: `${base} ${h.look}`.trim(), ...(h.state === 'auto' ? {} : { 'data-edit': h.state }) }
      : { className: base };
    return { text, control };
  };
  const date = hintFor('filledOn');
  const side = hintFor('side');
  const shares = hintFor('shares');
  const price = hintFor('price');
  const fee = hintFor('fee');
  const autoFee = draft.fee.trim() === '' ? autoFeeUsd(draft.shares, draft.price, row.costPpm) : '';

  return (
    <Modal wide title={`${t('pendingReviewTitle')} · ${row.ticker || '?'}`} onClose={onCancel} closeOnEscape={false}>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="max-h-[70vh] overflow-auto rounded border border-border bg-background">
          {row.captureId !== null && <ScreenshotLink captureId={row.captureId} imgClassName="w-full" />}
        </div>
        <div className="space-y-3">
          <Field label={t('pendingColDate')} hint={date.text}>
            <Input type="date" {...date.control} value={draft.filledOn} onChange={(e) => set({ filledOn: e.target.value })} />
          </Field>
          <Field label={t('pendingColSide')} hint={side.text}>
            <Select {...side.control} value={draft.side} onChange={(e) => set({ side: e.target.value })}>
              {draft.side === '' && <option value="">—</option>}
              <option value="buy">{t('orderSideBuy')}</option>
              <option value="sell">{t('orderSideSell')}</option>
            </Select>
          </Field>
          <Field label={t('pendingColQty')} hint={shares.text}>
            <Input
              {...shares.control}
              inputMode="numeric"
              value={draft.shares}
              onChange={(e) => set({ shares: e.target.value })}
            />
          </Field>
          <Field label={t('pendingColPrice')} hint={price.text}>
            <Input
              {...price.control}
              inputMode="decimal"
              value={draft.price}
              onChange={(e) => set({ price: e.target.value })}
            />
          </Field>
          <Field label={t('pendingColFee')} hint={fee.text}>
            <Input
              {...fee.control}
              inputMode="decimal"
              value={draft.fee}
              placeholder={autoFee ? t('pendingFeeAutoPlaceholder', { fee: autoFee }) : undefined}
              onChange={(e) => set({ fee: e.target.value })}
            />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button onClick={onCancel}>{t('cancel')}</Button>
            <Button variant="primary" onClick={() => onDone(draft)}>
              {t('pendingReviewDone')}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
