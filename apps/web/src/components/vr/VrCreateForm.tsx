// "New VR run" dialog: the opening cash, the first buy target and the V-formula settings.
import { useState } from 'react';

import { usdToCents } from '../../api';
import { vrApi } from '../../api.vr';
import type { VrFormula } from '../../api.vr.types';
import { errorText } from '../../errortext';
import { centsToUsdText } from '../../format';
import { isPercentText, percentTextToPpm } from '../../gaps';
import { useT } from '../../i18n';
import { useDefaultCostText } from '../hooks';
import { Button, Field, Input, Select } from '../ui';
import {
  VR_DEFAULT_SETTINGS_TEXT,
  VR_MAX_NAME,
  VR_TICKER_RE,
  formulaLabelKey,
  halfCents,
  parseVrSettingsText,
} from './vrText';

const FORMULAS: VrFormula[] = ['skill', 'basic'];

export function VrCreateForm({
  onCreated,
  onCancel,
  onRunCreated,
}: {
  onCreated: (id: number) => void;
  onCancel: () => void;
  /** Called once the server has created the run, before the dialog is closed. */
  onRunCreated?: (id: number) => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [cash, setCash] = useState('');
  // null = the initial stock follows half the cash; any edit pins it.
  const [stockText, setStockText] = useState<string | null>(null);
  const [g, setG] = useState(VR_DEFAULT_SETTINGS_TEXT.g);
  const [formula, setFormula] = useState<VrFormula>(VR_DEFAULT_SETTINGS_TEXT.formula);
  const [band, setBand] = useState(VR_DEFAULT_SETTINGS_TEXT.band);
  const [spendLimit, setSpendLimit] = useState(VR_DEFAULT_SETTINGS_TEXT.spendLimit);
  const [deposit, setDeposit] = useState(VR_DEFAULT_SETTINGS_TEXT.deposit);
  const [cost, setCost, costLoadFailed] = useDefaultCostText();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<number | null>(null);

  const cashCents = usdToCents(cash);
  const followText = cashCents !== null && cashCents > 0 ? centsToUsdText(halfCents(cashCents)) : '';

  const fail = (key: string) => {
    setError(t(key));
  };

  const submit = async () => {
    if (busy) return;
    setError(null);
    if (name.trim().length > VR_MAX_NAME) return fail('vr.invalidName');
    if (!VR_TICKER_RE.test(ticker.trim())) return fail('runInvalidTicker');
    if (cashCents === null || cashCents <= 0) return fail('vr.invalidCash');
    const stockCents = stockText === null ? halfCents(cashCents) : usdToCents(stockText);
    if (stockCents === null || stockCents <= 0 || stockCents > cashCents) return fail('vr.invalidInitialStock');
    const parsed = parseVrSettingsText({ g, formula, band, spendLimit, deposit });
    if ('errorKey' in parsed) return fail(parsed.errorKey);
    if (!isPercentText(cost.trim(), 3)) return fail('runInvalidCostPpm');

    setBusy(true);
    try {
      const res = await vrApi.createRun({
        name: name.trim() === '' ? ticker.trim().toUpperCase() : name.trim(),
        ticker: ticker.trim().toUpperCase(),
        cashCents,
        initialStockCents: stockCents,
        ...parsed.settings,
        costPpm: percentTextToPpm(cost.trim(), 3),
      });
      setCreatedId(res.id);
      onRunCreated?.(res.id);
    } catch (err) {
      setError(errorText(err, t, 'vrErr'));
    } finally {
      setBusy(false);
    }
  };

  if (createdId !== null) {
    return (
      <div className="space-y-4">
        <div role="status" className="rounded border border-positive/40 bg-positive/10 px-3 py-2 text-sm text-positive">
          {t('vr.created', { id: createdId })}{' '}
          <a href={`#/vr/${createdId}`} className="font-medium underline" onClick={() => onCreated(createdId)}>
            #{createdId}
          </a>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>{t('cancel')}</Button>
          <Button variant="primary" onClick={() => onCreated(createdId)}>
            {t('vr.runsTitle')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error !== null && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('runName')}>
          <Input data-testid="vrNameInput" value={name} onChange={(e) => setName(e.target.value)} autoFocus data-autofocus />
        </Field>
        <Field label={t('runTicker')}>
          <Input
            data-testid="vrTickerInput"
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            placeholder="TQQQ"
          />
        </Field>
        <Field label={t('vr.cashLabel')}>
          <Input
            data-testid="vrCashInput"
            value={cash}
            onChange={(e) => setCash(e.target.value)}
            inputMode="decimal"
            placeholder="10000"
          />
        </Field>
        <Field label={t('vr.initialStockLabel')} hint={t('vr.initialStockHint')}>
          <Input
            data-testid="vrStockInput"
            value={stockText ?? followText}
            onChange={(e) => setStockText(e.target.value)}
            inputMode="decimal"
          />
        </Field>
        <Field label={t('vr.gLabel')} hint={t('vr.gHint')}>
          <Input data-testid="vrGInput" value={g} onChange={(e) => setG(e.target.value)} inputMode="numeric" />
        </Field>
        <Field label={t('vr.formulaLabel')}>
          <Select data-testid="vrFormulaSelect" value={formula} onChange={(e) => setFormula(e.target.value as VrFormula)}>
            {FORMULAS.map((f) => (
              <option key={f} value={f}>
                {t(formulaLabelKey(f))}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('vr.bandLabel')} hint={t('vr.bandHint')}>
          <Input data-testid="vrBandInput" value={band} onChange={(e) => setBand(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label={t('vr.spendLimitLabel')} hint={t('vr.spendLimitHint')}>
          <Input
            data-testid="vrSpendLimitInput"
            value={spendLimit}
            onChange={(e) => setSpendLimit(e.target.value)}
            inputMode="decimal"
          />
        </Field>
        <Field label={t('vr.depositLabel')} hint={t('vr.depositHint')}>
          <Input data-testid="vrDepositInput" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
        </Field>
        <div>
          <Field label={t('runCostPpm')} hint={t('runForm.costHint')}>
            <Input
              data-testid="vrCostInput"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              inputMode="decimal"
              placeholder="0.070"
            />
          </Field>
          <span data-testid="vrCostDefaultFailed" role="status" className="mt-1 block text-[11px] text-warning">
            {costLoadFailed ? t('costDefaultFailed') : ''}
          </span>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{t('cancel')}</Button>
        <Button variant="primary" busy={busy} onClick={() => void submit()}>
          {t('create')}
        </Button>
      </div>
    </div>
  );
}
