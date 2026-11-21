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
  const [lastDeleteId, setLastDeleteId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<{ id: number; message: string } | null>(null);

  const remove = async (id: number) => {
    setBusyId(id);
    setLastDeleteId(id);
    setDeleteError(null);
    try {
      await api.deleteVisionReview(id);
    } catch (err) {
      setDeleteError({ id, message: err instanceof Error ? err.message : String(err) });
    } finally {
      await reload();
      setBusyId(null);
    }
  };

  const cancel = (id: number) => {
    setDeleteError((current) => (current?.id === id ? null : current));
    setLastDeleteId((current) => (current === id ? null : current));
  };

  // Every error is visible exactly once: in the card that owns it when that card is listed and
  // idle, otherwise at page level. Every reload on this page follows a delete, so a list error
  // belongs to the card of the last delete, except while that card's own request is in flight.
  const listed = (id: number | null) => id !== null && !!data?.some((e) => e.captureId === id);
  const cardListError = !!data && listed(lastDeleteId) && busyId !== lastDeleteId && deleteError?.id !== lastDeleteId;
  const entryError = (id: number): string | null =>
    deleteError?.id === id ? deleteError.message : cardListError && id === lastDeleteId ? (error ?? null) : null;
  const pageListError = cardListError ? undefined : error;
  const pageDeleteError = deleteError && !listed(deleteError.id) ? deleteError.message : null;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('visionReviewTitle')}</h1>
      <p className="text-sm text-muted-foreground">{t('visionReviewIntro')}</p>
      {pageListError && <ErrorNote message={pageListError} />}
      {pageDeleteError && <ErrorNote message={pageDeleteError} />}
      {loading && !data && <Spinner />}
      {data && data.length === 0 && <EmptyNote>{t('visionReviewEmpty')}</EmptyNote>}
      {data?.map((entry) => (
        <VisionReviewEntry
          key={entry.captureId}
          entry={entry}
          busy={busyId === entry.captureId}
          deleteDisabled={busyId !== null}
          error={entryError(entry.captureId)}
          onDelete={() => void remove(entry.captureId)}
          onCancel={() => cancel(entry.captureId)}
        />
      ))}
    </div>
  );
}
