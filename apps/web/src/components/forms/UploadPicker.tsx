import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { fileSizeText, UPLOAD_MIMES } from '../../uploadpick';
import type { UploadItem } from '../../uploadlines';

export interface UploadRefusal {
  name: string;
  reason: 'unsupported-image' | 'image-too-large';
}

function Thumbnail({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url === null ? (
    <div className="h-10 w-10 shrink-0 rounded bg-muted" />
  ) : (
    <img src={url} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
  );
}

/** Drop zone, file input and the picked list. Paste is listened for on the window while this is mounted. */
export function UploadPicker({
  items,
  refused,
  onAdd,
  onRemove,
}: {
  items: UploadItem[];
  refused: UploadRefusal[];
  onAdd: (files: File[]) => void;
  onRemove: (key: number) => void;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onPaste = (ev: ClipboardEvent) => {
      const files = Array.from(ev.clipboardData?.files ?? []);
      if (files.length === 0) return;
      ev.preventDefault();
      onAdd(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [onAdd]);

  return (
    <div className="space-y-3">
      <div
        data-testid="uploadDrop"
        className="rounded border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const files = Array.from(e.dataTransfer?.files ?? []);
          if (files.length > 0) onAdd(files);
        }}
      >
        {t('upload.drop')}{' '}
        <button type="button" className="text-primary underline" onClick={() => inputRef.current?.click()}>
          {t('upload.choose')}
        </button>
        <input
          ref={inputRef}
          data-testid="uploadInput"
          type="file"
          multiple
          accept={UPLOAD_MIMES.join(',')}
          tabIndex={-1}
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = ''; // picking the same file again still fires change
            if (files.length > 0) onAdd(files);
          }}
        />
      </div>
      {refused.length > 0 && (
        <ul className="space-y-1 text-xs text-destructive" role="alert">
          {refused.map((r, i) => (
            <li key={i}>{t('upload.refused', { name: r.name, reason: t(`captureErr.${r.reason}`) })}</li>
          ))}
        </ul>
      )}
      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.key} className="flex items-center gap-3 text-sm">
              <Thumbnail file={item.file} />
              <span className="min-w-0 flex-1 truncate">{item.file.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{fileSizeText(item.file.size)}</span>
              <button
                type="button"
                aria-label={t('upload.remove', { name: item.file.name })}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => onRemove(item.key)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
