import { useEffect, useMemo, useRef, useState } from 'react';

import type { NotificationDto } from '../api';
import { isoDateTime } from '../format';
import { useT } from '../i18n';
import { clampPage, PAGE_SIZES, pageCount, pageOfIndex, slicePage } from '../paging';
import type { PageSize } from '../paging';
import { Pager } from './Pager';
import { EmptyNote, TableWrap, Td, Th } from './ui';

// Newest first: sentAt descending, then id descending. The server does not order this list.
function newestFirst(a: NotificationDto, b: NotificationDto): number {
  if (a.sentAt !== b.sentAt) return a.sentAt < b.sentAt ? 1 : -1;
  return b.id - a.id;
}

export function NoticeList({ notifications, highlightId }: { notifications: NotificationDto[]; highlightId?: number }) {
  const t = useT();
  const marked = useRef<HTMLTableRowElement | null>(null);
  const sorted = useMemo(() => [...notifications].sort(newestFirst), [notifications]);
  const hitIndex = highlightId === undefined ? -1 : sorted.findIndex((n) => n.id === highlightId);
  const [size, setSize] = useState<PageSize>(PAGE_SIZES[0]);
  const [page, setPage] = useState(() => pageOfIndex(hitIndex, PAGE_SIZES[0]));
  // A new deep-link target while mounted jumps to its page (adjusted during render so the scroll effect sees the row).
  const [seenHighlight, setSeenHighlight] = useState(highlightId);
  if (seenHighlight !== highlightId) {
    setSeenHighlight(highlightId);
    setPage(pageOfIndex(hitIndex, size));
  }
  useEffect(() => {
    marked.current?.scrollIntoView({ block: 'center' });
  }, [highlightId]);
  if (sorted.length === 0) return <EmptyNote>{t('notifEmpty')}</EmptyNote>;
  const count = pageCount(sorted.length, size);
  const current = clampPage(page, count);
  return (
    <>
      <TableWrap>
        <thead>
          <tr>
            <Th>{t('notifColDate')}</Th>
            <Th>{t('notifColBody')}</Th>
            <Th className="text-right">{t('notifColChat')}</Th>
          </tr>
        </thead>
        <tbody>
          {slicePage(sorted, current, size).map((n) => {
            const hit = highlightId !== undefined && n.id === highlightId;
            return (
              <tr key={n.id} ref={hit ? marked : undefined} aria-current={hit ? 'true' : undefined} className={hit ? 'bg-primary/10' : undefined}>
                <Td className="whitespace-nowrap tabular-nums text-muted-foreground">{isoDateTime(n.sentAt)}</Td>
                <Td className="whitespace-pre-wrap">{n.text}</Td>
                {/* 'web' must match WEB_ONLY_CHAT_ID in apps/server/src/wire/broadcast.ts */}
                <Td className="text-right font-mono text-[11px] text-muted-foreground">{n.chatId === 'web' ? t('notifChatWeb') : n.chatId}</Td>
              </tr>
            );
          })}
        </tbody>
      </TableWrap>
      {/* Nothing to page or resize when the whole list fits on the smallest page. */}
      {sorted.length > PAGE_SIZES[0] && (
        <Pager
          page={current}
          count={count}
          size={size}
          sizes={PAGE_SIZES}
          onPage={setPage}
          onSize={(next) => {
            setSize(next);
            setPage(pageOfIndex(hitIndex, next));
          }}
        />
      )}
    </>
  );
}
