// Screenshots kept for review: what vision read, and what the operator booked.
import { useState } from 'react';
import { api } from '../api';
import { VisionReviewEntry } from '../components/VisionReviewEntry';
import { useAsync } from '../components/hooks';
import { EmptyNote, ErrorNote, Spinner } from '../components/ui';
import { useT } from '../i18n';

export function VisionReviewPage() {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => api.listVisionReviews(), []);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const remove = async (captureId: number) => {
    setBusyId(captureId);
    setDeleteError(null);
    try {
      await api.deleteVisionReview(captureId);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      await reload();
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('visionReviewTitle')}</h1>
      <p className="text-sm text-muted-foreground">{t('visionReviewIntro')}</p>
      {error && <ErrorNote message={error} />}
      {deleteError && <ErrorNote message={deleteError} />}
      {loading && !data && <Spinner />}
      {data && data.length === 0 && <EmptyNote>{t('visionReviewEmpty')}</EmptyNote>}
      {data?.map((entry) => (
        <VisionReviewEntry
          key={entry.captureId}
          entry={entry}
          busy={busyId === entry.captureId}
          onDelete={() => void remove(entry.captureId)}
        />
      ))}
    </div>
  );
}
