import { useState } from 'react';
import { api, ApiError, usdToCents } from '../../api';
import type { BucketDto } from '../../api';
import { useT } from '../../i18n';
import { cutLossToPpm, gapToPpm, isCutLossText, isGapText, ppmToPercentText } from '../../gaps';
import { priceUsd } from '../../format';
import { stopCheckUnavailable, underwaterStopCount } from '../../cutloss';
import { poolAfterTopUp } from '../../viewmodels';
import { Button, ErrorNote, Field, Input, Modal } from '../ui';

// Combined run edit: pool top-up + buy/sell price gaps + cut-loss, one Save.
// The pool field is a top-up (the endpoint sets an absolute amount, so we send
// current + addition); the gap and cut-loss fields are percent text in, integer
// ppm out (blank = 0 = strategy default / off). A new cut-loss can put the stop
// above the market for buckets already down; that is warned about (from the
// held buckets and latest close passed in), never blocked.
export function EditRunModal({
  runId,
  poolCents,
  initialBuyPpm,
  initialSellPpm,
  initialCutLossPpm,
  buckets,
  latestClose,
  onClose,
  onSaved,
}: {
  runId: number;
  poolCents: number;
  initialBuyPpm: number;
  initialSellPpm: number;
  initialCutLossPpm: number;
  buckets: BucketDto[];
  /** Latest known close, myriadths as a decimal string; null when unknown. */
  latestClose: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [amount, setAmount] = useState('');
  const [buyGap, setBuyGap] = useState(ppmToPercentText(initialBuyPpm));
  const [sellGap, setSellGap] = useState(ppmToPercentText(initialSellPpm));
  const [cutLoss, setCutLoss] = useState(ppmToPercentText(initialCutLossPpm, 1));
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const cutLossValid = cutLoss === '' || isCutLossText(cutLoss);
  const gapsValid = (buyGap === '' || isGapText(buyGap)) && (sellGap === '' || isGapText(sellGap)) && cutLossValid;
  const cutLossPpm = cutLossValid ? cutLossToPpm(cutLoss) : 0;
  const underwater = underwaterStopCount(buckets, cutLossPpm, latestClose);
  const closeUnknown = stopCheckUnavailable(buckets, cutLossPpm, latestClose);

  const submit = async () => {
    if (busy || !gapsValid) return;
    let total: number | null = null;
    if (amount !== '') {
      const add = usdToCents(amount);
      total = add === null ? null : poolAfterTopUp(poolCents, add);
      if (total === null) {
        setFieldError(t('poolInvalidAmount'));
        return;
      }
    }
    setBusy(true);
    setSubmitError(null);
    try {
      if (total !== null) await api.setPool(runId, total);
      await api.setGaps(runId, {
        buyGapPpm: gapToPpm(buyGap),
        sellGapPpm: gapToPpm(sellGap),
        cutLossPpm,
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) setSubmitError(`${t('runDetail.gapSaveFailed')} (${err.code})`);
      else setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('poolTitle')} onClose={onClose} closeOnEscape={false}>
      {saved ? (
        <div className="space-y-3">
          <div role="status" className="rounded border border-positive/40 bg-positive/10 px-3 py-2 text-sm text-positive">
            {t('poolAdded')}
          </div>
          <div className="flex justify-end">
            <Button onClick={onClose}>{t('close')}</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {fieldError !== null && <ErrorNote message={fieldError} />}
          {submitError !== null && <ErrorNote message={submitError} />}
          <Field label={t('poolAddAmount')}>
            <Input
              data-testid="poolTopupInput"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setFieldError(null);
              }}
              inputMode="decimal"
              placeholder="1000"
              autoFocus
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label={t('runDetail.buyGap')}>
              <Input
                data-testid="gapBuyInput"
                value={buyGap}
                onChange={(e) => setBuyGap(e.target.value)}
                inputMode="decimal"
                placeholder="0"
                invalid={buyGap !== '' && !isGapText(buyGap)}
              />
            </Field>
            <Field label={t('runDetail.sellGap')}>
              <Input
                data-testid="gapSellInput"
                value={sellGap}
                onChange={(e) => setSellGap(e.target.value)}
                inputMode="decimal"
                placeholder="0"
                invalid={sellGap !== '' && !isGapText(sellGap)}
              />
            </Field>
            <Field label={t('runForm.cutLossLabel')}>
              <Input
                data-testid="cutLossInput"
                value={cutLoss}
                onChange={(e) => setCutLoss(e.target.value)}
                inputMode="decimal"
                placeholder="0"
                invalid={!cutLossValid}
              />
            </Field>
          </div>
          {underwater > 0 && (
            <div
              role="status"
              data-testid="cutLossWarning"
              className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
            >
              {t('runDetail.cutLossUnderwater', { n: underwater, price: priceUsd(latestClose) })}
            </div>
          )}
          {closeUnknown && (
            <div
              role="status"
              data-testid="cutLossCloseUnknown"
              className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
            >
              {t('runDetail.cutLossCloseUnknown')}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t('cancel')}</Button>
            <Button variant="primary" busy={busy} disabled={!gapsValid} data-testid="runSaveBtn" onClick={() => void submit()}>
              {t('poolAddBtn')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
