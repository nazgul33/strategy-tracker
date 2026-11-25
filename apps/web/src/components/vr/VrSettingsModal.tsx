// Settings dialog of a VR run: G, formula, band, spend limit and the per-cycle deposit. Applies from the next cycle.
import { useState } from 'react';

import { vrApi } from '../../api.vr';
import type { VrFormula, VrRunDto } from '../../api.vr.types';
import { errorText } from '../../errortext';
import { centsToUsdText } from '../../format';
import { useT } from '../../i18n';
import { Button, ErrorNote, Field, Input, Modal, Select } from '../ui';
import { formulaLabelKey, parseVrSettingsText, ppmInputText } from './vrText';

const FORMULAS: VrFormula[] = ['skill', 'basic'];

export function VrSettingsModal({ run, onClose, onSaved }: { run: VrRunDto; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const s = run.settings;
  const [g, setG] = useState(String(s.g));
  const [formula, setFormula] = useState<VrFormula>(s.formula);
  const [band, setBand] = useState(ppmInputText(s.bandPpm));
  const [spendLimit, setSpendLimit] = useState(ppmInputText(s.spendLimitPpm));
  const [deposit, setDeposit] = useState(centsToUsdText(s.cycleDepositCents));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const submit = async () => {
    if (busy) return;
    setError(null);
    const parsed = parseVrSettingsText({ g, formula, band, spendLimit, deposit });
    if ('errorKey' in parsed) {
      setError(t(parsed.errorKey));
      return;
    }
    setBusy(true);
    try {
      await vrApi.saveSettings(run.id, parsed.settings);
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(errorText(err, t, 'vrErr'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('vr.settingsTitle')} onClose={onClose} closeOnEscape={false}>
      {saved ? (
        <div className="space-y-3">
          <div role="status" className="rounded border border-positive/40 bg-positive/10 px-3 py-2 text-sm text-positive">
            {t('vr.settingsSaved')}
          </div>
          <div className="flex justify-end">
            <Button onClick={onClose}>{t('close')}</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {error !== null && <ErrorNote message={error} />}
          <p data-testid="vrSettingsNote" className="text-sm text-muted-foreground">
            {t('vr.settingsNextCycle')}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('vr.gLabel')} hint={t('vr.gHint')}>
              <Input
                data-testid="vrGInput"
                value={g}
                onChange={(e) => setG(e.target.value)}
                inputMode="numeric"
                autoFocus
                data-autofocus
              />
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
          </div>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t('cancel')}</Button>
            <Button variant="primary" busy={busy} data-testid="vrSettingsSave" onClick={() => void submit()}>
              {t('save')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
