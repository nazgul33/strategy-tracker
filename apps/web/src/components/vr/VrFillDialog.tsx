// Add, edit and delete dialog of one VR fill. Unlike MR's FillDialog the side stays editable, the fee is left to the
// server until the operator types one, and a save dated before the current cycle ends on a note.
import { useState, type FormEvent } from 'react';
import { vrApi } from '../../api.vr';
import type { VrFillDto, VrFillInput, VrSide } from '../../api.vr.types';
import { autoFeeUsd } from '../../autofee';
import { errorText } from '../../errortext';
import { centsToUsdText, isoDate, priceInputValue } from '../../format';
import { useT } from '../../i18n';
import { Button, Field, Input, Modal, Select } from '../ui';
import { VrDeleteStep } from './VrDeleteStep';
import { vrFillChecks } from './vrFillChecks';

export interface VrFillDialogProps {
  runId: number;
  costPpm: number;
  /** The server's New York date, the default for a new fill. */
  today: string;
  /** When present the dialog edits this fill instead of adding a new one. */
  fill?: VrFillDto;
  /** Open on the delete confirmation (the row's Delete button). */
  startOnDelete?: boolean;
  onClose: () => void;
  onSaved: () => void;
}

type Step = 'form' | 'delete' | 'earlier' | 'earlierDeleted';

export function VrFillDialog({ runId, costPpm, today, fill, startOnDelete = false, onClose, onSaved }: VrFillDialogProps) {
  const t = useT();
  const [side, setSide] = useState<VrSide>(fill?.side ?? 'buy');
  const [shares, setShares] = useState(fill ? String(fill.shares) : '');
  const [price, setPrice] = useState(fill ? priceInputValue(fill.price) : '');
  const [fee, setFee] = useState(fill ? centsToUsdText(fill.fee) : '');
  const [filledOn, setFilledOn] = useState(fill ? isoDate(fill.filledOn) : today);
  const [feeTouched, setFeeTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(startOnDelete && fill ? 'delete' : 'form');

  const finish = () => {
    onSaved();
    onClose();
  };

  const syncAutoFee = (nextShares: string, nextPrice: string) => {
    if (!feeTouched) setFee(autoFeeUsd(nextShares, nextPrice, costPpm));
  };

  // The request body, or the message of the first failed client check.
  const input = (): VrFillInput | string => {
    const checked = vrFillChecks(t, { side, shares, price, fee, filledOn });
    if ('error' in checked) return checked.error;
    // An add on the auto fee sends none (the server computes it); an edit always sends the shown one, or the server
    // would recompute it and overwrite a fee the operator set earlier.
    const sendFee = fill !== undefined || feeTouched;
    return { ...checked.value, fee: sendFee ? checked.value.fee : undefined };
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
      let id = fill?.id;
      if (fill) await vrApi.updateFill(runId, fill.id, body);
      else id = (await vrApi.addFill(runId, body)).id;
      // Only the server knows where the current cycle starts; a failed re-read just skips the note.
      const earlier = await vrApi.listFills(runId).then(
        (rows) => rows.find((r) => r.id === id)?.beforeCycle === true,
        () => false,
      );
      if (earlier) setStep('earlier');
      else finish();
    } catch (err) {
      setError(errorText(err, t, 'vrErr'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!fill || busy) return;
    setBusy(true);
    setError(null);
    try {
      await vrApi.deleteFill(runId, fill.id);
      if (fill.beforeCycle) setStep('earlierDeleted');
      else finish();
    } catch (err) {
      setError(errorText(err, t, 'vrErr'));
    } finally {
      setBusy(false);
    }
  };

  const errorLine = error !== null && (
    <p data-testid="error" className="text-sm text-red-600 dark:text-red-400">
      {error}
    </p>
  );

  if (step === 'earlier' || step === 'earlierDeleted') {
    const deleted = step === 'earlierDeleted';
    return (
      <Modal title={t(deleted ? 'vr.fillDeletedTitle' : 'saved')} onClose={finish} closeOnEscape={false}>
        <p
          role="status"
          data-testid="vrEarlierCycleNote"
          className="rounded-md bg-warning/10 px-2 py-1.5 text-sm text-warning"
        >
          {t(deleted ? 'vr.fillDeletedNote' : 'vr.earlierCycleNote')}
        </p>
        <div className="mt-3 flex justify-end">
          <Button autoFocus data-autofocus onClick={finish}>
            {t('close')}
          </Button>
        </div>
      </Modal>
    );
  }

  if (step === 'delete' && fill) {
    return (
      <VrDeleteStep
        message={t('vr.fillDeleteWarning', { n: fill.shares })}
        busy={busy}
        onDelete={() => void remove()}
        onBack={() => {
          setError(null);
          if (startOnDelete) onClose();
          else setStep('form');
        }}
        onClose={onClose}
      >
        {errorLine}
      </VrDeleteStep>
    );
  }

  return (
    <Modal title={fill ? t('dialog.editFill') : t('dialog.addFill')} onClose={onClose} closeOnEscape={false}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <Field label={t('manualSide')}>
          <Select
            data-testid="vrFillSideSelect"
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
            data-testid="vrFillSharesInput"
            value={shares}
            onChange={(e) => {
              const v = e.target.value;
              setShares(v);
              syncAutoFee(v, price);
            }}
            inputMode="numeric"
            required
          />
        </Field>
        <Field label={t('manualPrice')} hint={t('manualPriceHint')}>
          <Input
            data-testid="vrFillPriceInput"
            value={price}
            onChange={(e) => {
              const v = e.target.value;
              setPrice(v);
              syncAutoFee(shares, v);
            }}
            inputMode="decimal"
            placeholder="349.99"
            required
          />
        </Field>
        <Field label={`${t('manualFee')} (${t('optional')})`}>
          <Input
            data-testid="vrFillFeeInput"
            value={fee}
            onChange={(e) => {
              const v = e.target.value;
              setFee(v);
              setFeeTouched(v.trim() !== '');
              if (v.trim() === '') setFee(autoFeeUsd(shares, price, costPpm));
            }}
            inputMode="decimal"
            placeholder="1.50"
          />
        </Field>
        <Field label={t('manualFilledOn')}>
          <Input
            type="date"
            data-testid="vrFillDateInput"
            value={filledOn}
            onChange={(e) => setFilledOn(e.target.value)}
            required
          />
        </Field>
        {errorLine}
        <div className="flex items-center gap-3">
          <Button onClick={onClose}>{t('cancel')}</Button>
          {fill && (
            <Button
              data-testid="vrFillDeleteBtn"
              onClick={() => {
                setError(null);
                setStep('delete');
              }}
            >
              {t('dialog.delete')}
            </Button>
          )}
          <Button type="submit" variant="primary" busy={busy}>
            {fill ? t('dialog.save') : t('dialog.add')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
