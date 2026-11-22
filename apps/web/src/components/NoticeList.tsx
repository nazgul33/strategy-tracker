import type { NotificationDto } from '../api';
import { isoDateTime } from '../format';
import { useT } from '../i18n';
import { EmptyNote, TableWrap, Td, Th } from './ui';

export function NoticeList({ notifications }: { notifications: NotificationDto[] }) {
  const t = useT();
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
        {notifications.map((n) => (
          <tr key={n.id}>
            <Td className="whitespace-nowrap tabular-nums text-muted-foreground">{isoDateTime(n.sentAt)}</Td>
            <Td className="whitespace-pre-wrap">{n.text}</Td>
            {/* 'web' must match WEB_ONLY_CHAT_ID in apps/server/src/wire/booking-notifier.ts */}
            <Td className="text-right font-mono text-[11px] text-muted-foreground">{n.chatId === 'web' ? t('notifChatWeb') : n.chatId}</Td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}
