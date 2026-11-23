import { useAsync } from '../components/hooks';
import { api } from '../api';
import { SimConfigPanel } from '../components/forms/SimConfigPanel';
import { SimReplay } from '../components/SimReplay';
import { Button, ErrorNote, SectionTitle, Spinner } from '../components/ui';
import { useT } from '../i18n';
import { parseSimParams } from '../simconfig';
import { simErrorText } from '../simerrors';

// Server default when a run stored no bucketCount and has no days to infer one from.
const DEFAULT_BUCKET_COUNT = 10;

export function SimRunPage({ id }: { id: number }) {
  const t = useT();
  const { data, error, failure, loading, reload } = useAsync(() => api.getSimRun(id), [id]);

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
          <ErrorNote message={simErrorText(failure, t)} />
          <Button variant="secondary" onClick={reload}>{t('retry')}</Button>
        </div>
      ) : data ? (
        <div className="space-y-4">
          <SimConfigPanel
            key={data.run.id}
            run={data.run}
            params={parseSimParams(data.run.paramsJson, data.days[data.days.length - 1]?.stateJson.buckets.length || DEFAULT_BUCKET_COUNT)}
            onApplied={() => void reload()}
          />
          <p className="text-sm text-ink-faint">{t('simDayCount', { count: data.days.length })}</p>
          <SimReplay run={data.run} days={data.days} />
        </div>
      ) : null}
    </div>
  );
}
