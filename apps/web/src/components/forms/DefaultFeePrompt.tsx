import { useT } from '../../i18n';
import { Button, Modal } from '../ui';

interface DefaultFeePromptProps {
  rate: string;
  price: string;
  shares: string;
  fee: string;
  onUse: () => void;
  onBack: () => void;
}

// Asked when Confirm is pressed with a blank fee: the server books the default
// fee for it, so show the formula and the amount. Closing the dialog goes back.
export function DefaultFeePrompt({ rate, price, shares, fee, onUse, onBack }: DefaultFeePromptProps) {
  const t = useT();
  return (
    <Modal title={t('pendingDefaultFeeTitle')} onClose={onBack}>
      <p className="mb-4 text-sm text-muted-foreground">{t('pendingDefaultFeeBody', { rate, price, shares, fee })}</p>
      <div className="flex justify-end gap-2">
        <Button variant="primary" onClick={onUse}>
          {t('pendingDefaultFeeUse')}
        </Button>
        <Button onClick={onBack}>{t('pendingDefaultFeeBack')}</Button>
      </div>
    </Modal>
  );
}
