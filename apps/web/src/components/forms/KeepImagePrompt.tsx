import { useT } from '../../i18n';
import { Button, Modal } from '../ui';

interface KeepImagePromptProps {
  action: 'confirm' | 'reject';
  onDecide: (keep: boolean) => void;
  onDismiss: () => void;
}

// Asked when vision probably misread a screenshot: the operator corrected the
// fill before confirming, or rejected it outright. Closing the dialog cancels
// the action; only the two buttons let it go ahead.
export function KeepImagePrompt({ action, onDecide, onDismiss }: KeepImagePromptProps) {
  const t = useT();
  return (
    <Modal title={t(action === 'reject' ? 'keepImageRejectTitle' : 'keepImageEditedTitle')} onClose={onDismiss}>
      <p className="mb-4 text-sm text-muted-foreground">
        {t(action === 'reject' ? 'keepImageRejectBody' : 'keepImageEditedBody')}
      </p>
      <div className="flex justify-end gap-2">
        <Button onClick={() => onDecide(false)}>{t('keepImageDiscard')}</Button>
        <Button variant="primary" onClick={() => onDecide(true)}>
          {t('keepImageKeep')}
        </Button>
      </div>
    </Modal>
  );
}
