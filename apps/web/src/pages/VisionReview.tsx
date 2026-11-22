// Screenshots kept for review: what vision read, and what the operator booked.
import { useState } from 'react';
import { ApiError, api } from '../api';
import { VisionReviewEntry } from '../components/VisionReviewEntry';
import { useAsync } from '../components/hooks';
import { Button, EmptyNote, ErrorNote, Spinner } from '../components/ui';
import { useT } from '../i18n';
import { visionReviewErrorText } from '../visionreviewerrors';

const without = (errors: Record<number, unknown>, id: number) => {
  const { [id]: _dropped, ...rest } = errors;
  return rest;
};

export function VisionReviewPage() {
  const t = useT();
  const { data, failure, loading, reload } = useAsync(() => api.listVisionReviews(), []);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [lastDeleteId, setLastDeleteId] = useState<number | null>(null);
  const [deleteErrors, setDeleteErrors] = useState<Record<number, unknown>>({});
  const [listDismissed, setListDismissed] = useState(false);
  const [reloading, setReloading] = useState(false);

  const remove = async (id: number) => {
    setBusyId(id);
    setLastDeleteId(id);
    setListDismissed(false);
    setDeleteErrors((current) => without(current, id));
    try {
      await api.deleteVisionReview(id);
    } catch (err) {
      // Already gone is what the operator wanted.
      if (!(err instanceof ApiError && err.code === 'not-found')) {
        setDeleteErrors((current) => ({ ...current, [id]: err }));
      }
    } finally {
      await reload();
      setBusyId(null);
    }
  };

  const cancel = (id: number) => {
    setDeleteErrors((current) => without(current, id));
    setLastDeleteId((current) => (current === id ? null : current));
  };

  const refresh = async () => {
    setListDismissed(false);
    setReloading(true);
    await reload();
    setReloading(false);
  };

  // Every error is visible exactly once: in its card while that card is listed and idle,
  // otherwise at page level until dismissed. Every reload except Reload follows a delete, so a
  // list error belongs to the card of the last delete, except while that card's own request is in
  // flight.
  const listText = failure === undefined ? null : visionReviewErrorText(failure, t);
  const listed = (id: number | null) => id !== null && !!data?.some((e) => e.captureId === id);
  const has = (id: number) => id in deleteErrors;
  const cardListError = listed(lastDeleteId) && busyId !== lastDeleteId && !has(lastDeleteId!);
  const entryError = (id: number): string | null =>
    has(id) ? visionReviewErrorText(deleteErrors[id], t) : cardListError && id === lastDeleteId ? listText : null;
  const pageListError = cardListError || listDismissed ? null : listText;
  const pageDeleteIds = Object.keys(deleteErrors)
    .map(Number)
    .filter((id) => !listed(id));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('visionReviewTitle')}</h1>
        <Button busy={reloading} disabled={busyId !== null} onClick={() => void refresh()}>
          {t('reload')}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t('visionReviewIntro')}</p>
      {pageListError && <ErrorNote message={pageListError} onDismiss={() => setListDismissed(true)} />}
      {pageDeleteIds.map((id) => (
        <ErrorNote
          key={id}
          message={visionReviewErrorText(deleteErrors[id], t)}
          onDismiss={() => setDeleteErrors((current) => without(current, id))}
        />
      ))}
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
