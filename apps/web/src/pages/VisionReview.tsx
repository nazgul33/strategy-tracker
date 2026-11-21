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

  const [lastDeleteId, setLastDeleteId] = useState<number | null>(null);

  const remove = async (captureId: number) => {
    setBusyId(captureId);
    setLastDeleteId(captureId);
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

  const cancel = () => {
    setLastDeleteId(null);
    setDeleteError(null);
  };

  // Every reload on this page follows a delete, so a list error while entries are on screen
  // belongs to the entry whose delete triggered it.
  const entryError = (captureId: number): string | null =>
    captureId === lastDeleteId ? (deleteError ?? (data ? (error ?? null) : null)) : null;
  // When the armed entry is no longer listed, its error has no card to sit in and stays at page
  // level. After Cancel a list error with entries on screen is dismissed with the armed state.
  const inCard = lastDeleteId !== null && !!data?.some((e) => e.captureId === lastDeleteId);
  const pageError = !data || (lastDeleteId !== null && !inCard) ? error : undefined;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('visionReviewTitle')}</h1>
      <p className="text-sm text-muted-foreground">{t('visionReviewIntro')}</p>
      {pageError && <ErrorNote message={pageError} />}
      {!inCard && deleteError && <ErrorNote message={deleteError} />}
      {loading && !data && <Spinner />}
      {data && data.length === 0 && <EmptyNote>{t('visionReviewEmpty')}</EmptyNote>}
      {data?.map((entry) => (
        <VisionReviewEntry
          key={entry.captureId}
          entry={entry}
          busy={busyId === entry.captureId}
          error={entryError(entry.captureId)}
          onDelete={() => void remove(entry.captureId)}
          onCancel={cancel}
        />
      ))}
    </div>
  );
}
