import { signedCentsUsd } from '../format';
import { useT } from '../i18n';
import { Button, Modal } from './ui';

export type RecalcResult = { deltaCents: number; fillCount: number };

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
      <p className="text-muted-foreground">{t('recalcDone.rebuilt', { n: result.fillCount })}</p>
    </div>
  );
}

/** Dismissable popup wrapping the summary; the parent decides what OK means. */
export function RecalcResultModal({ result, onClose }: { result: RecalcResult; onClose: () => void }) {
  const t = useT();
  return (
    <Modal title={t('recalcDone.title')} onClose={onClose}>
      <RecalcSummary result={result} />
      <div className="mt-4 flex justify-end">
        <Button variant="primary" onClick={onClose}>
          {t('recalcDone.ok')}
        </Button>
      </div>
    </Modal>
  );
}
