// Sim: start a new backtest (it opens as an editable draft) and list drafts
// and saved simulation runs.
import { useState } from 'react';
import type { FormEvent } from 'react';

import { api } from '../api';
import type { SimRunDto } from '../api';
import { SimConfigFields } from '../components/forms/SimConfigFields';
import { useAsync, useDefaultCostText } from '../components/hooks';
import { Button, Card, EmptyNote, ErrorNote, Field, Input, Modal, SectionTitle, Spinner, TableWrap, Td, Th } from '../components/ui';
import { centsUsd, costPercentText, isoDate, isoDateTime, todayIso } from '../format';
import { useT } from '../i18n';
import { parseSimTicker, simFieldFlags, validateSimConfig } from '../simconfig';
import type { SimConfigForm } from '../simconfig';
import { simErrorText } from '../simerrors';

type ConfigRest = Omit<SimConfigForm, 'cost'>;

function SimTable({ rows, onDiscard }: { rows: SimRunDto[]; onDiscard?: (id: number) => void }) {
  const t = useT();
  return (
    <TableWrap>
      <thead>
        <tr>
          <Th>{t('simColId')}</Th>
          <Th>{t('simColTicker')}</Th>
          <Th>{t('simColRange')}</Th>
          <Th className="text-right">{t('runColPool')}</Th>
          <Th className="text-right">{t('runColCost')}</Th>
          <Th>{t('simColCreated')}</Th>
          {onDiscard && <Th />}
        </tr>
      </thead>
      <tbody>
        {rows.map((sim) => (
          <tr key={sim.id} className="hover:bg-muted/50">
            <Td className="tabular-nums text-muted-foreground">{sim.id}</Td>
            <Td>
              <a href={`#/sim/${sim.id}`} className="font-medium text-primary hover:underline">
                {t('simDetailTitle', { id: sim.id })}
              </a>
              <div className="font-mono text-[11px] text-muted-foreground">{sim.ticker}</div>
            </Td>
            <Td className="whitespace-nowrap tabular-nums">
              {isoDate(sim.fromDate)} → {isoDate(sim.toDate)}
            </Td>
            <Td className="text-right tabular-nums">{centsUsd(sim.poolCents)}</Td>
            <Td className="text-right tabular-nums">{costPercentText(sim.costPpm)}</Td>
            <Td className="whitespace-nowrap tabular-nums text-muted-foreground">{isoDateTime(sim.createdAt)}</Td>
            {onDiscard && (
              <Td className="text-right">
                <Button data-testid={`simDiscardRow-${sim.id}`} onClick={() => onDiscard(sim.id)}>
                  {t('simDiscard')}
                </Button>
              </Td>
            )}
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

export function SimPage() {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => api.listSimRuns(), []);

  const [ticker, setTicker] = useState('');
  const [rest, setRest] = useState<ConfigRest>({
    from: todayIso(),
    to: '',
    pool: '',
    buyGap: '',
    sellGap: '',
    cutLoss: '',
    bucketCount: '',
    maxAge: '',
  });
  const [cost, setCost, costLoadFailed] = useDefaultCostText();
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState<number | null>(null);
  const [discardBusy, setDiscardBusy] = useState(false);

  const form: SimConfigForm = { ...rest, cost };
  const percentsValid = !Object.values(simFieldFlags(form)).some(Boolean);
  const drafts = (data ?? []).filter((s) => s.draft);
  const saved = (data ?? []).filter((s) => !s.draft);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // The button is disabled while a percent is malformed, but Enter in a text
    // field still fires a native submit: that path validates and explains.
    if (busy) return;
    const tid = parseSimTicker(ticker);
    if (tid === null) return setFieldError(t('simInvalidTicker'));
    const result = validateSimConfig(form, t);
    if (!result.ok) return setFieldError(result.error);
    setFieldError(null);
    setBusy(true);
    setSubmitError(null);
    try {
      const res = await api.runSim({ ticker: tid, ...result.input });
      window.location.hash = `#/sim/${res.id}`;
    } catch (err) {
      setSubmitError(simErrorText(err, t));
      setBusy(false);
    }
  };

  const discardDraft = async (id: number) => {
    setDiscardBusy(true);
    try {
      await api.deleteSimRun(id);
      setSubmitError(null);
    } catch (err) {
      // Same wording as the config panel: a draft saved elsewhere reads as "already saved".
      setSubmitError(simErrorText(err, t));
    }
    setDiscardBusy(false);
    setDiscarding(null);
    await reload();
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t('simTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('simIntro')}</p>
      </div>

      <Card>
        <form onSubmit={submit} className="max-w-3xl space-y-3">
          {fieldError !== null && <ErrorNote message={fieldError} />}
          {submitError !== null && <ErrorNote message={submitError} />}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t('simTicker')}>
              <Input value={ticker} onChange={(e) => setTicker(e.target.value)} maxLength={10} placeholder="AAA" required dir="ltr" />
            </Field>
          </div>
          <SimConfigFields
            form={form}
            onChange={(field, value) => (field === 'cost' ? setCost(value) : setRest((r) => ({ ...r, [field]: value })))}
            costNote={costLoadFailed ? t('costDefaultFailed') : undefined}
          />
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" busy={busy} disabled={!percentsValid}>
              {t('simRun')}
            </Button>
            {busy && <span className="text-sm text-muted-foreground">{t('simRunning')}</span>}
          </div>
        </form>
      </Card>

      {loading ? (
        <Card>
          <Spinner />
        </Card>
      ) : error ? (
        <Card>
          <div className="flex items-center gap-3">
            <ErrorNote message={error} />
            <Button onClick={() => void reload()}>{t('retry')}</Button>
          </div>
        </Card>
      ) : (
        <>
          {drafts.length > 0 && (
            <div data-testid="simDrafts">
              <Card>
                <SectionTitle>{t('simDrafts')}</SectionTitle>
                <SimTable rows={drafts} onDiscard={setDiscarding} />
              </Card>
            </div>
          )}
          <div data-testid="simSaved">
            <Card>
              <SectionTitle>{t('simSavedTitle')}</SectionTitle>
              {saved.length === 0 ? <EmptyNote>{t('simSavedEmpty')}</EmptyNote> : <SimTable rows={saved} />}
            </Card>
          </div>
        </>
      )}

      {discarding !== null && (
        <Modal title={t('simDiscard')} onClose={() => setDiscarding(null)}>
          <p className="text-sm">{t('simDiscardWarning', { id: discarding })}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button data-testid="simDiscardCancelBtn" onClick={() => setDiscarding(null)}>
              {t('cancel')}
            </Button>
            <Button variant="danger" busy={discardBusy} data-testid="simDiscardConfirmBtn" onClick={() => void discardDraft(discarding)}>
              {t('simDiscardConfirm')}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
