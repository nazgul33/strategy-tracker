// Edit dialog of one fill read from a screenshot and still waiting. An empty fee stays empty: the server computes it
// from the run's cost when the row is confirmed.
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api';
import { vrApi } from '../../api.vr';
import type { VrPendingDto, VrPendingInput, VrSide } from '../../api.vr.types';
import { autoFeeUsd } from '../../autofee';
import { errorText } from '../../errortext';
import { centsToUsdText, isoDate, priceInputValue } from '../../format';
import { useT } from '../../i18n';
import { Button, Field, Input, Modal, Select } from '../ui';
import { vrFillChecks } from './vrFillChecks';

export interface VrPendingDialogProps {
  runId: number;
  costPpm: number;
  row: VrPendingDto;
  onClose: () => void;
  onSaved: () => void;
  /** The row was already decided elsewhere: called when the dialog is closed, so the list can drop it. */
  onStale: () => void;
}

export function VrPendingDialog({ runId, costPpm, row, onClose, onSaved, onStale }: VrPendingDialogProps) {
  const t = useT();
  const [side, setSide] = useState<VrSide>(row.side);
  const [shares, setShares] = useState(String(row.shares));
  const [price, setPrice] = useState(priceInputValue(row.price));
  const [fee, setFee] = useState(row.fee === null ? '' : centsToUsdText(row.fee));
  const [filledOn, setFilledOn] = useState(isoDate(row.filledOn));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const close = () => {
    if (stale) onStale();
    onClose();
  };

  // The request body, or the message of the first failed client check.
  const input = (): VrPendingInput | string => {
    const checked = vrFillChecks(t, { side, shares, price, fee, filledOn });
    return 'error' in checked ? checked.error : checked.value;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const body = input();
    if (typeof body === 'string') {
      setError(body);
      return;
    }
    setBusy(true);
    try {
      await vrApi.updatePending(runId, row.id, body);
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'vr-not-pending') setStale(true);
      setError(errorText(err, t, 'vrErr'));
    } finally {
      setBusy(false);
    }
  };

  const auto = autoFeeUsd(shares, price, costPpm);

  return (
    <Modal title={t('vr.pendingEditTitle')} onClose={close} closeOnEscape={false}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <Field label={t('manualSide')}>
          <Select
            data-testid="vrPendingSideSelect"
            data-autofocus
            value={side}
            onChange={(e) => setSide(e.target.value as VrSide)}
          >
            <option value="buy">{t('orderSideBuy')}</option>
            <option value="sell">{t('orderSideSell')}</option>
          </Select>
        </Field>
        <Field label={t('manualQty')}>
          <Input
            data-testid="vrPendingSharesInput"
            value={shares}
            onChange={(e) => setShares(e.target.value)}
            inputMode="numeric"
            required
          />
        </Field>
        <Field label={t('manualPrice')} hint={t('manualPriceHint')}>
          <Input
            data-testid="vrPendingPriceInput"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
            placeholder="349.99"
            required
          />
        </Field>
        <Field label={`${t('manualFee')} (${t('optional')})`} hint={t('vr.pendingFeeHint')}>
          <Input
            data-testid="vrPendingFeeInput"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            inputMode="decimal"
            placeholder={auto === '' ? t('pendingFeeAuto') : t('pendingFeeAutoPlaceholder', { fee: auto })}
          />
        </Field>
        <Field label={t('manualFilledOn')}>
          <Input
            type="date"
            data-testid="vrPendingDateInput"
            value={filledOn}
            onChange={(e) => setFilledOn(e.target.value)}
            required
          />
        </Field>
        {error !== null && (
          <p data-testid="error" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex items-center gap-3">
          <Button onClick={close}>{t('cancel')}</Button>
          <Button type="submit" variant="primary" busy={busy}>
            {t('dialog.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
