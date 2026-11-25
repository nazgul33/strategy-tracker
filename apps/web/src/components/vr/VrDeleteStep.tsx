// The in-dialog confirm step of a VR fill or cash delete. The message comes in, because FillDeleteStep's wording is MR-only.
import type { ReactNode } from 'react';
import { useT } from '../../i18n';
import { Button, Modal } from '../ui';

export function VrDeleteStep({
  message,
  busy,
  onDelete,
  onBack,
  onClose,
  children,
}: {
  message: string;
  busy: boolean;
  onDelete: () => void;
  onBack: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <Modal title={t('dialog.delete')} onClose={onClose} closeOnEscape={false}>
      <p className="text-sm">{message}</p>
      {children}
      <div className="mt-3 flex items-center gap-3">
        <Button variant="danger" busy={busy} onClick={onDelete}>
          {t('dialog.deleteConfirm')}
        </Button>
        <Button autoFocus data-autofocus onClick={onBack}>
          {t('cancel')}
        </Button>
      </div>
    </Modal>
  );
}
