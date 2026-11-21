import { useState } from 'react';
import type { DetectedDto, VisionReviewEntryDto, VisionReviewFillDto } from '../api.types';
import { centsUsd, isoDate, isoDateTime, priceUsd } from '../format';
import { useT } from '../i18n';
import { ScreenshotLink } from './ScreenshotLink';
import { Badge, Button, Card, TableWrap, Td, Th } from './ui';

type Field = keyof DetectedDto;
const FIELDS: readonly Field[] = ['side', 'shares', 'filledOn', 'price', 'fee'];
const FIELD_LABEL: Record<Field, string> = {
  side: 'pendingColSide',
  shares: 'pendingColQty',
  filledOn: 'pendingColDate',
  price: 'pendingColPrice',
  fee: 'pendingColFee',
};

// A rejected fill has no final values; every field of a confirmed one is compared. The fee is
// the exception: the system derives it when vision read none, so a differing fee is a change
// only when the operator supplied one (`feeOverridden`). Checking `edited` instead would
// highlight the derived fee again whenever any other field was corrected.
function changedFields(fill: VisionReviewFillDto): ReadonlySet<Field> {
  if (!fill.final) return new Set();
  const { detected, final } = fill;
  return new Set(FIELDS.filter((f) => detected[f] !== final[f] && (f !== 'fee' || fill.feeOverridden)));
}

// Vision read no fee and the operator did not supply one: the booked fee is the derived one.
function feeWasDerived(fill: VisionReviewFillDto): boolean {
  return fill.final !== null && !fill.feeOverridden && fill.detected.fee === null && fill.final.fee !== null;
}

function FillRows({ fill }: { fill: VisionReviewFillDto }) {
  const t = useT();
  const changed = changedFields(fill);
  const derivedFee = feeWasDerived(fill);

  const show = (field: Field, value: DetectedDto): string => {
    switch (field) {
      case 'side':
        return value.side === 'buy' ? t('orderSideBuy') : value.side === 'sell' ? t('orderSideSell') : '—';
      case 'shares':
        return value.shares === null ? '—' : String(value.shares);
      case 'filledOn':
        return isoDate(value.filledOn);
      case 'price':
        return priceUsd(value.price);
      case 'fee':
        return centsUsd(value.fee);
    }
  };

  const row = (kind: 'detected' | 'final', values: DetectedDto | null) => (
    <tr data-fill={fill.id} data-row={kind}>
      {kind === 'detected' && (
        <Td className="whitespace-nowrap font-medium" rowSpan={2}>
          <div>{t('correctionFill', { id: fill.id })}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge tone={fill.outcome === 'rejected' ? 'danger' : 'success'}>
              {t(fill.outcome === 'rejected' ? 'pendingRejected' : 'pendingConfirmed')}
            </Badge>
            {fill.outcome === 'confirmed' && (
              <Badge tone={fill.edited ? 'warning' : 'neutral'}>
                {t(fill.edited ? 'visionReviewEdited' : 'visionReviewAsRead')}
              </Badge>
            )}
          </div>
        </Td>
      )}
      <Td className="whitespace-nowrap text-muted-foreground">
        {t(kind === 'detected' ? 'visionReviewRowDetected' : 'visionReviewRowFinal')}
      </Td>
      {FIELDS.map((field) => {
        const isChanged = changed.has(field);
        return (
          <Td key={field} className="whitespace-nowrap tabular-nums">
            <span
              data-field={field}
              data-changed={isChanged ? 'true' : undefined}
              className={`rounded px-1 py-0.5 ${isChanged ? 'bg-warning/15 font-semibold text-warning' : ''}`}
            >
              {values ? show(field, values) : '—'}
            </span>
            {isChanged && (
              <span role="img" aria-label={t('visionReviewChangedMark')} className="ml-1 text-warning">
                ✎
              </span>
            )}
            {field === 'fee' && kind === 'final' && derivedFee && (
              <span data-auto-fee className="ml-1 text-xs text-muted-foreground">
                {t('visionReviewFeeAuto')}
              </span>
            )}
          </Td>
        );
      })}
    </tr>
  );

  return (
    <>
      {row('detected', fill.detected)}
      {row('final', fill.final)}
    </>
  );
}

// One kept screenshot: the image, and per fill what vision read against what
// was booked, with the fields the operator changed marked.
export function VisionReviewEntry({
  entry,
  onDelete,
  busy = false,
}: {
  entry: VisionReviewEntryDto;
  onDelete: () => void;
  busy?: boolean;
}) {
  const t = useT();
  const [armed, setArmed] = useState(false);
  return (
    <Card>
      <div data-capture={entry.captureId} className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-semibold">{entry.ticker}</span>
          <a href={`#/runs/${entry.runId}`} className="text-xs text-primary underline">
            {t('visionReviewRun', { id: entry.runId })}
          </a>
          <span className="text-xs tabular-nums text-muted-foreground">{isoDateTime(entry.createdAt)}</span>
          <span className="text-xs tabular-nums text-muted-foreground">{Math.max(1, Math.round(entry.byteLen / 1024))} KB</span>
          {!armed && (
            <Button className="ml-auto" variant="danger" onClick={() => setArmed(true)}>
              {t('visionReviewDelete')}
            </Button>
          )}
        </div>
        {armed && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2">
            <span className="text-sm text-destructive">{t('visionReviewDeleteWarning')}</span>
            <div className="ml-auto flex gap-2">
              <Button disabled={busy} onClick={() => setArmed(false)}>
                {t('cancel')}
              </Button>
              <Button variant="danger" busy={busy} onClick={onDelete}>
                {t('dialog.deleteConfirm')}
              </Button>
            </div>
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
          <div className="max-h-80 overflow-auto rounded border border-border bg-background">
            <ScreenshotLink captureId={entry.captureId} imgClassName="w-full" />
          </div>
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('tabFills')}</Th>
                <Th>
                  <span className="sr-only">{t('visionReviewColSource')}</span>
                </Th>
                {FIELDS.map((f) => (
                  <Th key={f}>{t(FIELD_LABEL[f])}</Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entry.fills.map((fill) => (
                <FillRows key={fill.id} fill={fill} />
              ))}
            </tbody>
          </TableWrap>
        </div>
      </div>
    </Card>
  );
}
