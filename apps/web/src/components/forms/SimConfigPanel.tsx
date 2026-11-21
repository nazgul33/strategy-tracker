// The current simulation config, right under the ticker. A draft is editable:
// Apply re-runs it in place as often as you like, Save moves it into the
// append-only history, Discard throws it away. A saved sim shows the same
// fields read-only.
import { useState } from 'react';

import { api, ApiError } from '../../api';
import type { SimRunDto } from '../../api';
import { useT } from '../../i18n';
import { formFromRun, simFieldFlags, validateSimConfig } from '../../simconfig';
import type { SimConfigForm, SimParams } from '../../simconfig';
import { simErrorText } from '../../simerrors';
import { Badge, Button, Card, ErrorNote, Modal } from '../ui';
import { SimConfigFields } from './SimConfigFields';

type Busy = 'apply' | 'save' | 'discard' | null;

export function SimConfigPanel({
  run,
  params,
  onApplied,
}: {
  run: SimRunDto;
  params: SimParams;
  onApplied: () => void;
}) {
  const t = useT();
  const [form, setForm] = useState<SimConfigForm>(() => formFromRun(run, params));
  // What the displayed results were computed from; Save is only offered for that.
  const [applied, setApplied] = useState<SimConfigForm>(form);
  const [savedHere, setSavedHere] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const readOnly = !run.draft || savedHere;
  const dirty = JSON.stringify(form) !== JSON.stringify(applied);
  const percentsValid = !Object.values(simFieldFlags(form)).some(Boolean);

  const fail = (err: unknown) => {
    setError(simErrorText(err, t));
    if (err instanceof ApiError && err.code === 'sim-finalized') onApplied();
  };

  const apply = async () => {
    if (busy) return;
    const result = validateSimConfig(form, t);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setBusy('apply');
    setError(null);
    try {
      await api.updateSimRun(run.id, result.input);
      setApplied(form);
      onApplied();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (busy) return;
    setBusy('save');
    setError(null);
    try {
      await api.saveSimRun(run.id);
      setSavedHere(true);
      onApplied();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    if (busy) return;
    setBusy('discard');
    try {
      await api.deleteSimRun(run.id);
      window.location.hash = '#/sim';
    } catch (err) {
      setConfirming(false);
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-mono text-lg font-semibold" data-testid="simConfigTicker">
          {run.ticker}
        </h2>
        <span data-testid="simStatusBadge">
          <Badge tone={readOnly ? 'success' : 'warning'}>{t(readOnly ? 'simBadgeSaved' : 'simBadgeDraft')}</Badge>
        </span>
        <span className="text-xs text-muted-foreground">{t(readOnly ? 'simFinalizedHint' : 'simDraftHint')}</span>
      </div>

      {error !== null && <ErrorNote message={error} />}
      <SimConfigFields form={form} onChange={(field, value) => setForm((f) => ({ ...f, [field]: value }))} disabled={readOnly} />

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            busy={busy === 'apply'}
            disabled={!percentsValid || busy !== null}
            data-testid="simApplyBtn"
            onClick={() => void apply()}
          >
            {t('simApply')}
          </Button>
          <Button
            busy={busy === 'save'}
            disabled={dirty || !percentsValid || busy !== null}
            data-testid="simSaveBtn"
            onClick={() => void save()}
          >
            {t('simSave')}
          </Button>
          <Button variant="danger" disabled={busy !== null} data-testid="simDiscardBtn" onClick={() => setConfirming(true)}>
            {t('simDiscard')}
          </Button>
          {dirty && <span className="text-xs text-muted-foreground">{t('simDirtyHint')}</span>}
        </div>
      )}

      {confirming && (
        <Modal title={t('simDiscard')} onClose={() => setConfirming(false)}>
          <p className="text-sm">{t('simDiscardWarning', { id: run.id })}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button data-testid="simDiscardCancelBtn" onClick={() => setConfirming(false)}>
              {t('cancel')}
            </Button>
            <Button variant="danger" busy={busy === 'discard'} data-testid="simDiscardConfirmBtn" onClick={() => void discard()}>
              {t('simDiscardConfirm')}
            </Button>
          </div>
        </Modal>
      )}
    </Card>
  );
}
