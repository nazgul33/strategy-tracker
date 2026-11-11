// Global pending queue. PendingTable fetches, confirms and rejects on its own.
import { PendingTable } from '../components/forms/PendingTable';
import { Card } from '../components/ui';
import { useT } from '../i18n';

export function PendingPage() {
  const t = useT();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('pendingTitle')}</h1>
      <Card>
        <PendingTable />
      </Card>
    </div>
  );
}
