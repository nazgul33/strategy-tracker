import { useEffect, useRef } from 'react';

import type { NotificationDto } from '../api';
import { isoDateTime } from '../format';
import { useT } from '../i18n';
import { EmptyNote, TableWrap, Td, Th } from './ui';

export function NoticeList({ notifications, highlightId }: { notifications: NotificationDto[]; highlightId?: number }) {
  const t = useT();
  const marked = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    marked.current?.scrollIntoView({ block: 'center' });
  }, [highlightId]);
  if (notifications.length === 0) return <EmptyNote>{t('notifEmpty')}</EmptyNote>;
  return (
    <TableWrap>
      <thead>
        <tr>
          <Th>{t('notifColDate')}</Th>
          <Th>{t('notifColBody')}</Th>
          <Th className="text-right">{t('notifColChat')}</Th>
        </tr>
      </thead>
      <tbody>
        {notifications.map((n) => {
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
  );
}
