// Add, edit and delete dialog of one VR cash movement. The form takes a positive amount for a deposit or a withdrawal
// and signs it by kind; an adjustment is typed with its sign. The opening cash can be edited but not deleted.
import { useState, type FormEvent } from 'react';
import { vrApi } from '../../api.vr';
import type { VrCashDto, VrCashInput, VrCashKind } from '../../api.vr.types';
import { errorText } from '../../errortext';
import { centsToUsdText, isoDate, signedCentsUsd } from '../../format';
import { useT } from '../../i18n';
import { usdToCents } from '../../usd';
import { enumLabelKey } from '../../viewmodels';
import { Button, Field, Input, Modal, Select } from '../ui';
import { VrDeleteStep } from './VrDeleteStep';
import { signedUsdTextToCents } from './vrText';

const MAX_CENTS = 2_147_483_647;
const MAX_NOTE = 255;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ADD_KINDS: VrCashInput['kind'][] = ['deposit', 'withdraw', 'adjust'];

export interface VrCashDialogProps {
  runId: number;
  /** The server's New York date, the default for a new movement. */
  today: string;
  /** When present the dialog edits this movement instead of adding a new one. */
  move?: VrCashDto;
  /** Open on the delete confirmation (the row's Delete button). */
  startOnDelete?: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function VrCashDialog({ runId, today, move, startOnDelete = false, onClose, onSaved }: VrCashDialogProps) {
  const t = useT();
  const deletable = move !== undefined && move.kind !== 'open';
  const [kind, setKind] = useState<VrCashKind>(move?.kind ?? 'deposit');
  const [amount, setAmount] = useState(
    move ? centsToUsdText(move.kind === 'adjust' ? move.amountCents : Math.abs(move.amountCents)) : '',
  );
  const [movedOn, setMovedOn] = useState(move ? isoDate(move.movedOn) : today);
  const [note, setNote] = useState(move?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'form' | 'delete'>(startOnDelete && deletable ? 'delete' : 'form');

  // The signed cents of the typed amount, or the message of the failed check.
  const signedAmount = (): number | string => {
    const cents = kind === 'adjust' ? signedUsdTextToCents(amount) : usdToCents(amount);
    if (cents === null || cents === 0) return t(kind === 'adjust' ? 'vr.invalidAdjustAmount' : 'vr.invalidCashAmount');
    if (Math.abs(cents) > MAX_CENTS) return t('vr.cashAmountTooLarge');
    return kind === 'withdraw' ? -cents : cents;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const amountCents = signedAmount();
    if (typeof amountCents === 'string') return setError(amountCents);
    if (!ISO_DATE.test(movedOn)) return setError(t('manualInvalidDate'));
    const text = note.trim();
    if (text.length > MAX_NOTE) return setError(t('vrErr.invalid-note'));
    setBusy(true);
    try {
      // An edit always sends the note: the server stores an absent one as empty and would wipe a kept note.
      if (move) await vrApi.updateCash(runId, move.id, { amountCents, movedOn, note: text });
      else await vrApi.addCash(runId, { kind: kind as VrCashInput['kind'], amountCents, movedOn, note: text === '' ? undefined : text });
      onSaved();
      onClose();
    } catch (err) {
      setError(errorText(err, t, 'vrErr'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!move || busy) return;
    setBusy(true);
    setError(null);
    try {
      await vrApi.deleteCash(runId, move.id);
      onSaved();
      onClose();
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

  if (step === 'delete' && move) {
    return (
      <VrDeleteStep
        message={t('vr.cashDeleteWarning', { amount: signedCentsUsd(move.amountCents) })}
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
    <Modal title={move ? t('vr.editCash') : t('vr.addCash')} onClose={onClose} closeOnEscape={false}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <Field label={t('vr.colKind')}>
          {move ? (
            <Select data-testid="vrCashKindSelect" value={move.kind} disabled onChange={() => {}}>
              <option value={move.kind}>{t(enumLabelKey('vr.kind', move.kind))}</option>
            </Select>
          ) : (
            <Select data-testid="vrCashKindSelect" data-autofocus value={kind} onChange={(e) => setKind(e.target.value as VrCashKind)}>
              {ADD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(enumLabelKey('vr.kind', k))}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('vr.colAmount')} hint={t(kind === 'adjust' ? 'vr.adjustAmountHint' : 'vr.cashAmountHint')}>
          <Input
            data-testid="vrCashAmountInput"
            data-autofocus={move ? true : undefined}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode={kind === 'adjust' ? 'text' : 'decimal'}
            required
          />
        </Field>
        <Field label={t('vr.colDate')}>
          <Input type="date" data-testid="vrCashDateInput" value={movedOn} onChange={(e) => setMovedOn(e.target.value)} required />
        </Field>
        <Field label={`${t('manualNote')} (${t('optional')})`}>
          <Input data-testid="vrCashNoteInput" value={note} onChange={(e) => setNote(e.target.value)} maxLength={MAX_NOTE} />
        </Field>
        {errorLine}
        <div className="flex items-center gap-3">
          <Button onClick={onClose}>{t('cancel')}</Button>
          {deletable && (
            <Button
              data-testid="vrCashDeleteBtn"
              onClick={() => {
                setError(null);
                setStep('delete');
              }}
            >
              {t('dialog.delete')}
            </Button>
          )}
          <Button type="submit" variant="primary" busy={busy}>
            {t('save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
