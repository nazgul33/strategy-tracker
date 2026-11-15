// Global pending queue. PendingTable fetches, confirms and rejects on its own.
import { CorrectionList } from '../components/forms/CorrectionList';
import { PendingTable } from '../components/forms/PendingTable';
import { Card, SectionTitle } from '../components/ui';
import { useT } from '../i18n';

export function PendingPage() {
  const t = useT();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('pendingPageTitle')}</h1>
      <CorrectionList framed />
      <Card>
        <SectionTitle>{t('pendingTitle')}</SectionTitle>
        <PendingTable />
      </Card>
    </div>
  );
}
