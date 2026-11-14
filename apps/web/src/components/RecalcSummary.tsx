import { signedCentsUsd } from '../format';
import { useT } from '../i18n';
import { Button, Modal } from './ui';

/**
 * Outcome of a recompute shown to the operator. `fillCount` comes from the
 * explicit recalc endpoint only; fill edit/delete responses carry just the
 * booked delta, so the rebuilt-count line is omitted when it is absent.
 */
export type RecalcResult = { deltaCents: number; fillCount?: number };

/** Plain-text outcome of a recalc: cash adjustment (if any) + rebuilt fill count. */
export function RecalcSummary({ result }: { result: RecalcResult }) {
  const t = useT();
  return (
    <div className="space-y-1 text-sm">
      {result.deltaCents !== 0 ? (
        <p>{t('recalcDone.adjusted', { delta: signedCentsUsd(result.deltaCents) })}</p>
      ) : (
        <p>{t('recalcDone.noAdjust')}</p>
      )}
      {result.fillCount !== undefined && (
        <p className="text-muted-foreground">{t('recalcDone.rebuilt', { n: result.fillCount })}</p>
      )}
    </div>
  );
}

/** Dismissable popup wrapping the summary; the parent decides what OK means. */
export function RecalcResultModal({ result, onClose }: { result: RecalcResult; onClose: () => void }) {
  const t = useT();
  return (
    <Modal title={t('recalcDone.title')} onClose={onClose}>
      <div data-testid="recalc-result-modal">
        <RecalcSummary result={result} />
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant="primary" data-testid="recalcOkBtn" onClick={onClose}>
          {t('recalcDone.ok')}
        </Button>
      </div>
    </Modal>
  );
}
