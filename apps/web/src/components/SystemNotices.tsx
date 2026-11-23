// Global notice feed under the runs table: run notices link to the run's
// Notifications tab, global ones (calendar, reminders, pipeline errors) expand
// in place. The page remounts this component (key) to reload page one.
import { useState } from 'react';

import { api } from '../api';
import type { NoticeEntryDto } from '../api';
import { isoDateTime } from '../format';
import { useT } from '../i18n';
import { handleUnauthorized, useAsync } from './hooks';
import { Button, Card, EmptyNote, ErrorNote, SectionTitle, Spinner, TableWrap, Td, Th } from './ui';

const firstLine = (text: string): string => text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';

export function SystemNotices() {
  const t = useT();
  const first = useAsync(() => api.listNotices(), []);
  const [older, setOlder] = useState<NoticeEntryDto[]>([]);
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const entries = [...(first.data?.entries ?? []), ...older];
  const nextBefore = cursor === undefined ? (first.data?.nextBefore ?? null) : cursor;

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const showOlder = async () => {
    if (nextBefore === null) return;
    setOlderBusy(true);
    setOlderError(null);
    try {
      const page = await api.listNotices(nextBefore);
      setOlder((prev) => [...prev, ...page.entries]);
      setCursor(page.nextBefore);
    } catch (err) {
      handleUnauthorized(err);
      setOlderError(err instanceof Error ? err.message : String(err));
    } finally {
      setOlderBusy(false);
    }
  };

  // 'web' must match WEB_ONLY_CHAT_ID in apps/server/src/wire/broadcast.ts
  const chats = (e: NoticeEntryDto) => e.chatIds.map((c) => (c === 'web' ? t('notifChatWeb') : c)).join(', ');

  return (
    <Card>
      <SectionTitle>{t('systemNoticesTitle')}</SectionTitle>
      {first.loading ? (
        <Spinner />
      ) : first.error ? (
        <div className="flex items-center gap-3">
          <ErrorNote message={first.error} />
          <Button onClick={() => void first.reload()}>{t('retry')}</Button>
        </div>
      ) : entries.length === 0 ? (
        <EmptyNote>{t('notifEmpty')}</EmptyNote>
      ) : (
        <>
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('notifColDate')}</Th>
                <Th>{t('systemNoticesSource')}</Th>
                <Th>{t('notifColBody')}</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const open = expanded.has(e.id);
                return (
                  <tr key={e.id}>
                    <Td className="whitespace-nowrap tabular-nums text-muted-foreground">{isoDateTime(e.sentAt)}</Td>
                    <Td className="whitespace-nowrap text-muted-foreground">
                      {e.runId === null ? t('systemNoticesSystem') : `#${e.runId}${e.ticker === null ? '' : ` ${e.ticker}`}`}
                    </Td>
                    <Td className="max-w-0 w-full">
                      {e.runId === null ? (
                        <button
                          type="button"
                          aria-expanded={open}
                          onClick={() => toggle(e.id)}
                          className="block w-full truncate text-left text-primary hover:underline"
                        >
                          {firstLine(e.text)}
                        </button>
                      ) : (
                        <a
                          href={`#/runs/${e.runId}?tab=notifications&notice=${e.id}`}
                          className="block truncate text-primary hover:underline"
                        >
                          {firstLine(e.text)}
                        </a>
                      )}
                      {e.runId === null && open && (
                        <>
                          <div className="mt-1 whitespace-pre-wrap">{e.text}</div>
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            {t('notifColChat')}: {chats(e)}
                          </div>
                        </>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
          {olderError !== null && (
            <div className="mt-3">
              <ErrorNote message={olderError} />
            </div>
          )}
          {nextBefore !== null && (
            <div className="mt-3">
              <Button busy={olderBusy} onClick={() => void showOlder()}>
                {t('systemNoticesOlder')}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
