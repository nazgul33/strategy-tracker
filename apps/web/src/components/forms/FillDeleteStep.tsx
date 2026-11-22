import type { ReactNode } from 'react';
import { useT } from '../../i18n';
import { Button, Modal } from '../ui';

// The in-dialog confirm step of FillDialog's Delete. The closed-bucket note and
// the error line come in as children so they stay shared with the form step.
export function FillDeleteStep({
  shares,
  busy,
  onDelete,
  onBack,
  onClose,
  children,
}: {
  shares: number;
  busy: boolean;
  onDelete: () => void;
  onBack: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <Modal title={t('dialog.delete')} onClose={onClose} closeOnEscape={false}>
      <p className="text-sm">{t('dialog.deleteWarning', { n: shares })}</p>
      {children}
      <div className="mt-3 flex items-center gap-3">
        <Button variant="danger" busy={busy} onClick={onDelete}>
          {t('dialog.deleteConfirm')}
        </Button>
        <Button autoFocus onClick={onBack}>
          {t('cancel')}
        </Button>
      </div>
    </Modal>
  );
}
