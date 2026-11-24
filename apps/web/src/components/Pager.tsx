// Generic previous/next pager with a page-size select. Pages are zero-based in
// props and shown one-based; the paging math lives in ../paging.ts.
import { useId } from 'react';

import { useT } from '../i18n';
import { Button, Select } from './ui';

export function Pager<S extends number>({
  page,
  count,
  size,
  sizes,
  onPage,
  onSize,
}: {
  page: number;
  count: number;
  size: S;
  sizes: readonly S[];
  onPage: (page: number) => void;
  onSize: (size: S) => void;
}) {
  const t = useT();
  const sizeId = useId();
  return (
    <nav data-testid="pager" aria-label={t('pager.label')} className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
      <div className="flex items-center gap-2">
        <label htmlFor={sizeId} className="text-muted-foreground">
          {t('pager.perPage')}
        </label>
        <Select
          id={sizeId}
          value={size}
          onChange={(e) => onSize(sizes.find((s) => s === Number(e.target.value)) ?? size)}
          className="py-1 text-xs"
        >
          {sizes.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <Button disabled={page <= 0} onClick={() => onPage(page - 1)} className="px-2 py-1 text-xs">
          {t('pager.prev')}
        </Button>
        <span data-testid="pager-status" aria-live="polite" className="tabular-nums text-muted-foreground">
          {t('pager.status', { page: page + 1, count })}
        </span>
        <Button disabled={page >= count - 1} onClick={() => onPage(page + 1)} className="px-2 py-1 text-xs">
          {t('pager.next')}
        </Button>
      </div>
    </nav>
  );
}
