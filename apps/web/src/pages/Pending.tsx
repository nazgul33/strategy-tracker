// Global pending queue. PendingTable fetches, confirms and rejects on its own.
import { useState } from 'react';
import { CorrectionList } from '../components/forms/CorrectionList';
import { PendingTable } from '../components/forms/PendingTable';
import { UploadDialog } from '../components/forms/UploadDialog';
import { Button, Card, SectionTitle } from '../components/ui';
import { useT } from '../i18n';

export function PendingPage() {
  const t = useT();
  const [uploadOpen, setUploadOpen] = useState(false);
  // Bumped after an upload: the table re-reads in place, the corrections remount.
  const [refresh, setRefresh] = useState(0);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('pendingPageTitle')}</h1>
        <Button data-testid="uploadScreenshot" variant="secondary" onClick={() => setUploadOpen(true)}>
          {t('upload.title')}
        </Button>
      </div>
      <CorrectionList key={`c${refresh}`} framed />
      <Card>
        <SectionTitle>{t('pendingTitle')}</SectionTitle>
        <PendingTable refreshKey={refresh} />
      </Card>
      {uploadOpen && (
        <UploadDialog
          onClose={({ uploaded, goToPending }) => {
            setUploadOpen(false);
            // "Go to pending" lands on this same page, so it refreshes like a plain close.
            if (uploaded || goToPending) setRefresh((r) => r + 1);
          }}
        />
      )}
    </div>
  );
}
