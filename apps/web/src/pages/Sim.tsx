// Sim: start a new backtest replay and list past simulation runs.
import { useState } from 'react';
import type { FormEvent } from 'react';

import { api, usdToCents } from '../api';
import type { SimInput } from '../api';
import { useAsync } from '../components/hooks';
import {
  Button,
  Card,
  EmptyNote,
  ErrorNote,
  Field,
  Input,
  Spinner,
  TableWrap,
  Td,
  Th,
} from '../components/ui';
import { bpPercent, centsUsd, isoDate, isoDateTime, todayIso } from '../format';
import { useT } from '../i18n';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function SimPage() {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => api.listSimRuns(), []);

  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [fromDate, setFromDate] = useState(() => todayIso());
  const [toDate, setToDate] = useState('');
  const [poolUsd, setPoolUsd] = useState('');
  const [costPpm, setCostPpm] = useState('200');
  const [bucketCount, setBucketCount] = useState('');
  const [sellCap, setSellCap] = useState('');
  const [maxAge, setMaxAge] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function validate(): SimInput | null {
    const tid = ticker.trim().toUpperCase();
    if (!/^[A-Za-z.]{1,10}$/.test(tid)) return fail(t('simInvalidTicker'));
    if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate)) return fail(t('simInvalidDate'));
    if (fromDate >= toDate) return fail(t('simInvalidRange'));
    const poolCents = usdToCents(poolUsd);
    if (poolCents === null || poolCents <= 0) return fail(t('simInvalidPool'));
    const cost = costPpm.trim();
    if (!/^\d{1,7}$/.test(cost)) return fail(t('runInvalidCostPpm'));

    const buckets = optInt(bucketCount, 2, 20, t('runInvalidBucketCount'));
    if (buckets === null) return null;
    const cap = optInt(sellCap, 1, 100, t('runInvalidSellCap'));
    if (cap === null) return null;
    const age = optInt(maxAge, 1, 250, t('runInvalidMaxAge'));
    if (age === null) return null;

    setFieldError(null);
    const input: SimInput = { name: name.trim(), ticker: tid, from: fromDate, to: toDate, poolCents, costPpm: Number(cost) };
    const params: NonNullable<SimInput['params']> = {};
    if (buckets !== undefined) params.bucketCount = buckets;
    if (cap !== undefined) params.sellCapBps = cap;
    if (age !== undefined) params.maxAgeDays = age;
    if (Object.keys(params).length > 0) input.params = params;
    return input;
  }

  function fail(message: string): null {
    setFieldError(message);
    return null;
  }

  /** Optional integer input → number | undefined; `null` (via fail) when invalid. */
  function optInt(value: string, min: number, max: number, message: string): number | null | undefined {
    const text = value.trim();
    if (!text) return undefined;
    if (!/^\d{1,3}$/.test(text)) return fail(message);
    const n = Number(text);
    if (n < min || n > max) return fail(message);
    return n;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const input = validate();
    if (!input) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const res = await api.runSim(input);
      window.location.hash = `#/sim/${res.id}`;
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t('simTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('simIntro')}</p>
      </div>

      <Card>
        <form onSubmit={submit} className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
          {fieldError !== null && <ErrorNote message={fieldError} />}
          {submitError !== null && <div className="sm:col-span-2"><ErrorNote message={submitError} /></div>}
          <Field label={t('simName')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
          <Field label={t('simTicker')}>
            <Input value={ticker} onChange={(e) => setTicker(e.target.value)} maxLength={10} placeholder="AAA" required dir="ltr" />
          </Field>
          <Field label={t('simStart')}>
            <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} required />
          </Field>
          <Field label={t('simEnd')}>
            <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} required />
          </Field>
          <Field label={t('simPool')}>
            <Input value={poolUsd} onChange={(e) => setPoolUsd(e.target.value)} inputMode="decimal" placeholder="100000" required />
          </Field>
          <Field label={t('simCostPpm')}>
            <Input value={costPpm} onChange={(e) => setCostPpm(e.target.value)} inputMode="numeric" required />
          </Field>
          <details className="text-sm sm:col-span-2">
            <summary className="cursor-pointer text-muted-foreground">{t('runParamsOptional')}</summary>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t('runBucketCount')}>
                <Input value={bucketCount} onChange={(e) => setBucketCount(e.target.value)} inputMode="numeric" />
              </Field>
              <Field label={t('simSellCap')}>
                <Input value={sellCap} onChange={(e) => setSellCap(e.target.value)} inputMode="numeric" />
              </Field>
              <Field label={t('simMaxAge')}>
                <Input value={maxAge} onChange={(e) => setMaxAge(e.target.value)} inputMode="numeric" />
              </Field>
            </div>
          </details>
          <div className="flex items-center gap-3 sm:col-span-2">
            <Button type="submit" variant="primary" busy={busy}>
              {t('simRun')}
            </Button>
            {busy && <span className="text-sm text-muted-foreground">{t('simRunning')}</span>}
          </div>
        </form>
      </Card>

      <Card>
        {loading ? (
          <Spinner />
        ) : error ? (
          <div className="flex items-center gap-3">
            <ErrorNote message={error} />
            <Button onClick={() => void reload()}>{t('retry')}</Button>
          </div>
        ) : (data ?? []).length === 0 ? (
          <EmptyNote>{t('simEmpty')}</EmptyNote>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('simColId')}</Th>
                <Th>{t('simColTicker')}</Th>
                <Th>{t('simColRange')}</Th>
                <Th className="text-right">{t('runColPool')}</Th>
                <Th className="text-right">{t('runColCost')}</Th>
                <Th>{t('simColCreated')}</Th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((sim) => (
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
                  <Td className="text-right tabular-nums">{bpPercent(sim.costPpm / 100)}</Td>
                  <Td className="whitespace-nowrap tabular-nums text-muted-foreground">{isoDateTime(sim.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
