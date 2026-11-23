// DTOs of the global notice feed (GET /api/notifications), split from api.types.ts to keep it small.
import type { NotificationDto } from './api.types';

/** One message of the global feed: the per-chat rows of one broadcast collapsed; `id` is the newest row's id. */
export interface NoticeEntryDto extends Omit<NotificationDto, 'chatId'> {
  ticker: string | null;
  chatIds: string[];
}

export interface NoticePageDto {
  entries: NoticeEntryDto[];
  nextBefore: number | null;
}
