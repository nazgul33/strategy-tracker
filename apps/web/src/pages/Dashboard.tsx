// Dashboard: every active and paused run of both strategies, valued at the server's last stored close.
// The page only formats what the server sends; it adds nothing up.
import { dashboardApi, type DashboardGroupDto, type DashboardRowDto } from '../api.dashboard';
import { useAsync } from '../components/hooks';
import { Badge, Button, Card, EmptyNote, ErrorNote, Spinner, TableWrap, Td, Th } from '../components/ui';
import { centsUsd, isoDate, priceUsd } from '../format';
import { useT } from '../i18n';
import { enumLabelKey, runStatusTone } from '../viewmodels';

function CloseCell({ row }: { row: DashboardRowDto }) {
  const t = useT();
  if (row.closeMark === 'missing') {
    return (
      <span data-testid="dashCloseMissing" className="text-warning">
        {t('dash.closeMissing')}
      </span>
    );
  }
  if (row.close === null) return null;
  if (row.closeMark === 'older') {
    return (
      <>
        {priceUsd(row.close)}
        <div data-testid="dashCloseOlder" className="text-[11px] text-warning">
          {t('dash.closeOlder', { date: isoDate(row.closeDate) })}
        </div>
      </>
    );
  }
  return <>{priceUsd(row.close)}</>;
}

function GroupCard({ group: g }: { group: DashboardGroupDto }) {
  const t = useT();
  const mr = g.strategy === 'mean-reversion';
  return (
    <section data-testid={`dashGroup-${g.strategy}`}>
      <Card className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">{t(mr ? 'dash.strategyMr' : 'dash.strategyVr')}</h2>
          <div className="text-sm text-muted-foreground">
            {t('dash.total')}{' '}
            <span data-testid={`dashTotal-${g.strategy}`} className="font-semibold tabular-nums text-foreground">
              {centsUsd(g.totalCents)}
            </span>
          </div>
        </div>
        {g.incomplete && (
          <p data-testid={`dashIncomplete-${g.strategy}`} className="text-xs text-warning">
            {t('dash.totalIncomplete')}
          </p>
        )}
        {g.olderClose && (
          <p data-testid={`dashOlderClose-${g.strategy}`} className="text-xs text-warning">
            {t('dash.totalOlderClose')}
          </p>
        )}
        {g.runs.length === 0 ? (
          <EmptyNote>{t('dash.empty')}</EmptyNote>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('dash.colRun')}</Th>
                <Th>{t('dash.colTicker')}</Th>
                <Th>{t('dash.colStatus')}</Th>
                <Th className="text-right">{t('dash.colShares')}</Th>
                <Th className="text-right">{t('dash.colClose')}</Th>
                <Th className="text-right">{t('dash.colStockValue')}</Th>
                <Th className="text-right">{t(mr ? 'dash.colCash' : 'dash.colPool')}</Th>
                <Th className="text-right">{t('dash.colValue')}</Th>
                <Th className="text-right">{t('dash.colWaiting')}</Th>
              </tr>
            </thead>
            <tbody>
              {g.runs.map((r) => (
                <tr key={r.id} data-testid={`dashRow-${g.strategy}-${r.id}`} className="hover:bg-muted/50">
                  <Td>
                    <a href={mr ? `#/runs/${r.id}` : `#/vr/${r.id}`} className="font-medium text-primary hover:underline">
                      {r.name}
                    </a>
                  </Td>
                  <Td>
                    <span className="font-mono">{r.ticker}</span>
                  </Td>
                  <Td>
                    <Badge tone={runStatusTone(r.status)}>{t(enumLabelKey('status', r.status))}</Badge>
                  </Td>
                  <Td className="text-right tabular-nums">{r.shares}</Td>
                  <Td className="text-right tabular-nums">
                    <CloseCell row={r} />
                  </Td>
                  <Td className="text-right tabular-nums">{r.stockCents === null ? '' : centsUsd(r.stockCents)}</Td>
                  <Td className="text-right tabular-nums">{centsUsd(r.cashCents)}</Td>
                  <Td className="text-right tabular-nums">{centsUsd(r.valueCents)}</Td>
                  <Td className="text-right tabular-nums">
                    {r.waiting > 0 && (
                      <a
                        href={mr ? '#/pending' : `#/vr/${r.id}?tab=pending`}
                        data-testid={`dashWaiting-${g.strategy}-${r.id}`}
                        className="font-medium text-warning hover:underline"
                      >
                        {r.waiting}
                      </a>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </section>
  );
}

export function DashboardPage() {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => dashboardApi.get(), []);

  return (
    <div className="space-y-4" data-testid="dashboard-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('dash.title')}</h1>
        <div className="flex items-center gap-3">
          {data?.closeDate && (
            <span data-testid="dashClosesOf" className="text-sm text-muted-foreground">
              {t('dash.closesOf', { date: isoDate(data.closeDate) })}
            </span>
          )}
          <Button data-testid="dashReload" onClick={() => void reload()}>
            {t('dash.reload')}
          </Button>
        </div>
      </div>

      {loading ? (
        <Card>
          <Spinner />
        </Card>
      ) : error ? (
        <Card>
          <div className="flex items-center gap-3">
            <ErrorNote message={error} />
            <Button onClick={() => void reload()}>{t('retry')}</Button>
          </div>
        </Card>
      ) : (
        data?.groups.map((g) => <GroupCard key={g.strategy} group={g} />)
      )}
    </div>
  );
}
