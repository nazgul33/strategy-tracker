// Pure client-side paging math. Pages are zero-based here; the Pager shows them one-based.

export const PAGE_SIZES = [5, 10, 20] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

/** Number of pages for `total` items; an empty list still has one (empty) page. */
export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}

export function clampPage(page: number, count: number): number {
  return Math.min(Math.max(page, 0), Math.max(count - 1, 0));
}

/** Page holding the item at `index`; a missing item (index < 0) maps to the first page. */
export function pageOfIndex(index: number, size: number): number {
  return index < 0 ? 0 : Math.floor(index / size);
}

export function slicePage<T>(items: readonly T[], page: number, size: number): T[] {
  return items.slice(page * size, page * size + size);
}
