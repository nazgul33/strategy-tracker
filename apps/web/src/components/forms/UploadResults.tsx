import { useT } from '../../i18n';
import { uploadItemLines } from '../../uploadlines';
import type { UploadItem, UploadLineTone } from '../../uploadlines';

const GLYPH: Record<UploadLineTone, string> = { ok: '✓', info: '–', warn: '⚠', error: '✕' };

const TONE_CLASS: Record<UploadLineTone, string> = {
  ok: 'text-positive',
  info: 'text-muted-foreground',
  warn: 'text-warning',
  error: 'text-destructive',
};

const DEPTH_CLASS = ['', 'pl-4', 'pl-8'] as const;

/** Per-file result lines once every upload has answered. */
export function UploadResults({ items }: { items: UploadItem[] }) {
  const t = useT();
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <section key={item.key} data-upload-result>
          <h4 className="mb-1 truncate text-sm font-medium">{item.file.name}</h4>
          <ul className="space-y-0.5 text-xs">
            {uploadItemLines(item, t).map((l, i) => (
              <li key={i} className={`flex gap-1.5 ${DEPTH_CLASS[l.depth]}`}>
                <span aria-hidden="true" className={`shrink-0 ${TONE_CLASS[l.tone]}`}>
                  {GLYPH[l.tone]}
                </span>
                {l.href === undefined ? (
                  <span className="min-w-0 break-words">{l.text}</span>
                ) : (
                  <a href={l.href} className="min-w-0 break-words text-primary underline">
                    {l.text}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
