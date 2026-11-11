import { useAsync } from '../components/hooks';
import { api } from '../api';
import { SimReplay } from '../components/SimReplay';
import { Button, ErrorNote, SectionTitle, Spinner } from '../components/ui';
import { isoDate } from '../format';
import { useT } from '../i18n';

export function SimRunPage({ id }: { id: number }) {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => api.getSimRun(id), [id]);

  return (
    <div>
      <SectionTitle>{t('simDetailTitle', { id })}</SectionTitle>
      <p className="mb-4 text-sm">
        <a href="#/sim" className="text-accent hover:underline">{t('simBack')}</a>
      </p>
      {loading && !data ? (
        <Spinner />
      ) : error ? (
        <div className="space-y-3">
          <ErrorNote message={error} />
          <Button variant="secondary" onClick={reload}>{t('retry')}</Button>
        </div>
      ) : data ? (
        <div className="space-y-4">
          <p className="text-sm text-ink-faint">
            <span className="font-semibold text-ink">{data.run.ticker}</span>
            {' · '}{isoDate(data.run.fromDate)} → {isoDate(data.run.toDate)}
            {' · '}{t('simDayCount', { count: data.days.length })}
          </p>
          <SimReplay run={data.run} days={data.days} />
        </div>
      ) : null}
    </div>
  );
}
