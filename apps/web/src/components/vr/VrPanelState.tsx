// Error text with a Retry button, for the self-fetching VR panels.
import { useT } from '../../i18n';
import { Button, ErrorNote } from '../ui';

export function VrPanelState({ error, onRetry }: { error: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="flex items-center gap-3">
      <ErrorNote message={error} />
      <Button onClick={onRetry}>{t('retry')}</Button>
    </div>
  );
}
