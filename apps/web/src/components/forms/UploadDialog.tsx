import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { useT } from '../../i18n';
import { pickRefusal } from '../../uploadpick';
import { wantsPending } from '../../uploadlines';
import type { UploadItem } from '../../uploadlines';
import { MODAL_FOCUSABLE } from '../Modal';
import { Button, Modal } from '../ui';
import { UploadPicker } from './UploadPicker';
import type { UploadRefusal } from './UploadPicker';
import { UploadResults } from './UploadResults';

export interface UploadCloseOutcome {
  uploaded: boolean;
  goToPending: boolean;
}

type Phase = 'picking' | 'uploading' | 'done';

// A phase change disables or removes controls; one that held focus would let
// it slip out of the dialog, since the Tab trap only cycles enabled controls.
function keepFocusInPanel(panel: HTMLElement): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== panel && panel.contains(active) && active.matches(MODAL_FOCUSABLE)) return;
  (panel.querySelector<HTMLElement>(MODAL_FOCUSABLE) ?? panel).focus();
}

/** Screenshot upload popup: pick files, send them one at a time, then show what each one did. */
export function UploadDialog({ runId, onClose }: { runId?: number; onClose: (outcome: UploadCloseOutcome) => void }) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>('picking');
  const [items, setItems] = useState<UploadItem[]>([]);
  const [refused, setRefused] = useState<UploadRefusal[]>([]);
  const [uploaded, setUploaded] = useState(false);
  const nextKey = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const panel = bodyRef.current?.closest<HTMLElement>('[data-modal-panel]');
    if (panel) keepFocusInPanel(panel);
  }, [phase]);

  const add = useCallback((files: File[]) => {
    const accepted: UploadItem[] = [];
    const rejected: UploadRefusal[] = [];
    for (const file of files) {
      const reason = pickRefusal(file);
      if (reason === null) accepted.push({ key: nextKey.current++, file, state: 'waiting' });
      else rejected.push({ name: file.name, reason });
    }
    if (accepted.length > 0) setItems((prev) => [...prev, ...accepted]);
    if (rejected.length > 0) setRefused((prev) => [...prev, ...rejected]);
  }, []);

  const remove = useCallback((key: number) => setItems((prev) => prev.filter((i) => i.key !== key)), []);

  const update = (key: number, patch: Partial<UploadItem>) =>
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  async function start() {
    const queue = items;
    setPhase('uploading');
    setUploaded(true);
    for (const item of queue) {
      update(item.key, { state: 'reading' });
      try {
        const events = await api.uploadCapture(item.file, runId);
        update(item.key, { state: 'done', events });
      } catch (error) {
        update(item.key, { state: 'failed', error });
      }
    }
    setPhase('done');
  }

  function more() {
    setItems([]);
    setRefused([]);
    setPhase('picking');
  }

  const close = (goToPending = false) => onClose({ uploaded, goToPending });

  return (
    <Modal title={t('upload.title')} onClose={() => close()} dismissible={phase !== 'uploading'}>
      <div ref={bodyRef} className="space-y-4">
        {phase === 'picking' && <UploadPicker items={items} refused={refused} onAdd={add} onRemove={remove} />}
        {phase === 'uploading' && (
          <ul className="space-y-1 text-sm">
            {items.map((item) => (
              <li key={item.key} className="flex justify-between gap-3">
                <span className="min-w-0 truncate">{item.file.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{t(`upload.${item.state}`)}</span>
              </li>
            ))}
          </ul>
        )}
        {phase === 'done' && <UploadResults items={items} />}
        <div className="flex justify-end gap-2">
          {phase === 'done' ? (
            <>
              <Button data-testid="uploadMore" onClick={more}>
                {t('upload.more')}
              </Button>
              {wantsPending(items) ? (
                <Button data-testid="uploadGoToPending" variant="primary" onClick={() => close(true)}>
                  {t('upload.goToPending')}
                </Button>
              ) : (
                <Button data-testid="uploadClose" variant="primary" onClick={() => close()}>
                  {t('close')}
                </Button>
              )}
            </>
          ) : (
            <>
              <Button disabled={phase === 'uploading'} onClick={() => close()}>
                {t('cancel')}
              </Button>
              <Button
                data-testid="uploadSubmit"
                variant="primary"
                disabled={phase === 'uploading' || items.length === 0}
                onClick={() => void start()}
              >
                {t('upload.submit', { count: items.length })}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
