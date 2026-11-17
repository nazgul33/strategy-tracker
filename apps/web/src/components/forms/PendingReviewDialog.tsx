import { useState } from 'react';
import { api, type PendingFillDto } from '../../api';
import { useT } from '../../i18n';
import type { RowValues } from '../../viewmodels';
import { Button, Field, Input, Modal, Select } from '../ui';

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
  const set = (patch: Partial<RowValues>) => setDraft((prev) => ({ ...prev, ...patch }));

  return (
    <Modal wide title={`${t('pendingReviewTitle')} · ${row.ticker || '?'}`} onClose={onCancel}>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="max-h-[70vh] overflow-auto rounded border border-border bg-background">
          {row.captureId !== null && (
            <img src={api.captureImageUrl(row.captureId)} alt={t('pendingScreenshotAlt')} className="w-full" />
          )}
        </div>
        <div className="space-y-3">
          <Field label={t('pendingColDate')}>
            <Input
              type="date"
              className="w-full"
              value={draft.filledOn}
              onChange={(e) => set({ filledOn: e.target.value })}
            />
          </Field>
          <Field label={t('pendingColSide')}>
            <Select className="w-full" value={draft.side} onChange={(e) => set({ side: e.target.value })}>
              {draft.side === '' && <option value="">—</option>}
              <option value="buy">{t('orderSideBuy')}</option>
              <option value="sell">{t('orderSideSell')}</option>
            </Select>
          </Field>
          <Field label={t('pendingColQty')}>
            <Input
              className="w-full"
              inputMode="numeric"
              value={draft.shares}
              onChange={(e) => set({ shares: e.target.value })}
            />
          </Field>
          <Field label={t('pendingColPrice')}>
            <Input
              className="w-full"
              inputMode="decimal"
              value={draft.price}
              onChange={(e) => set({ price: e.target.value })}
            />
          </Field>
          <Field label={t('pendingColFee')}>
            <Input
              className="w-full"
              inputMode="decimal"
              value={draft.fee}
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
