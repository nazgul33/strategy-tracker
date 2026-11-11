// Per-run order price gaps editor: percent text in, integer ppm out (0 = the
// strategy default). Saved via POST /api/runs/:id/gaps.
import { useState } from 'react';

import { api, ApiError } from '../../api';
import { gapToPpm, isGapText, ppmToPercentText } from '../../gaps';
import { useT } from '../../i18n';
import { Button, ErrorNote, Field, Input } from '../ui';

export function GapEditForm({
  runId,
  initialBuyPpm,
  initialSellPpm,
  onSaved,
}: {
  runId: number;
  initialBuyPpm: number;
  initialSellPpm: number;
  onSaved: () => void;
}) {
  const t = useT();
  const [buyGap, setBuyGap] = useState(ppmToPercentText(initialBuyPpm));
  const [sellGap, setSellGap] = useState(ppmToPercentText(initialSellPpm));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const gapsValid = (buyGap === '' || isGapText(buyGap)) && (sellGap === '' || isGapText(sellGap));

  const submit = async () => {
    if (busy || !gapsValid) return;
    setError(null);
    setBusy(true);
    try {
      await api.setGaps(runId, { buyGapPpm: gapToPpm(buyGap), sellGapPpm: gapToPpm(sellGap) });
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) setError(`${t('runDetail.gapSaveFailed')} (${err.code})`);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {error !== null && <ErrorNote message={error} />}
      <div className="grid grid-cols-2 gap-3">
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
      </div>
      <div className="flex justify-end">
        <Button variant="primary" busy={busy} disabled={!gapsValid} onClick={() => void submit()}>
          {t('runDetail.gapSave')}
        </Button>
      </div>
    </div>
  );
}
