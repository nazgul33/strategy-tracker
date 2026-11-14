import type { FillDto } from '../api';
import { fillSourceTone, myriadthsToUsdText, notionalCents } from '../viewmodels';
import { centsUsd, isoDate, priceUsd } from '../format';
import { useT } from '../i18n';
import { Badge, Button, EmptyNote, TableWrap, Td, Th } from './ui';

interface FillTableProps {
  fills: FillDto[];
  /** Opens the edit dialog for one fill; omit it to hide the actions column. */
  onEdit?: (fill: FillDto) => void;
  /** Ids whose rows get a Delete button; consulted only when onDelete is set. */
  deletableIds?: Set<number>;
  /** Requests deletion of one fill; omit it to hide the per-row delete buttons. */
  onDelete?: (fill: FillDto) => void;
}

export function FillTable({ fills, onEdit, deletableIds, onDelete }: FillTableProps) {
  const t = useT();
  if (fills.length === 0) return <EmptyNote>{t('fillEmpty')}</EmptyNote>;
  return (
    <TableWrap>
      <thead>
        <tr>
          <Th>{t('fillColSide')}</Th>
          <Th className="text-right">{t('fillColQty')}</Th>
          <Th className="text-right">{t('fillColPrice')}</Th>
          <Th className="text-right">{t('fillColValue')}</Th>
          <Th className="text-right">{t('fillColFee')}</Th>
          <Th>{t('fillColFilled')}</Th>
          <Th>{t('fillColSource')}</Th>
          <Th className="text-right">{t('fillColBucket')}</Th>
          {(onEdit || onDelete) && <Th className="text-right">{t('fillColActions')}</Th>}
        </tr>
      </thead>
      <tbody>
        {fills.map((f) => (
          <tr key={f.id}>
            <Td>
              <Badge tone={f.side === 'buy' ? 'info' : 'primary'}>
                {t(f.side === 'buy' ? 'orderSideBuy' : 'orderSideSell')}
              </Badge>
            </Td>
            <Td className="text-right tabular-nums">{f.shares}</Td>
            <Td className="text-right tabular-nums">{priceUsd(f.price)}</Td>
            <Td className="text-right tabular-nums">
              {centsUsd(notionalCents(myriadthsToUsdText(f.price) ?? '', f.shares))}
            </Td>
            <Td className="text-right tabular-nums">{centsUsd(f.fee)}</Td>
            <Td className="whitespace-nowrap tabular-nums">{isoDate(f.filledOn)}</Td>
            <Td>
              <Badge tone={fillSourceTone(f.source)}>{t(enumSourceKey(f.source))}</Badge>
            </Td>
            <Td className="text-right tabular-nums">{f.bucketIdx + 1}</Td>
            {(onEdit || onDelete) && (
              <Td className="text-right">
                <div className="flex justify-end gap-2">
                  {onEdit && (
                    <Button variant="secondary" id={`fillEdit-${f.id}`} onClick={() => onEdit(f)}>
                      {t('fillEdit')}
                    </Button>
                  )}
                  {onDelete && deletableIds?.has(f.id) && (
                    <Button variant="secondary" id={`fillDelete-${f.id}`} onClick={() => onDelete(f)}>
                      {t('dialog.delete')}
                    </Button>
                  )}
                </div>
              </Td>
            )}
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

function enumSourceKey(source: FillDto['source']): string {
  return 'fillSource' + source[0].toUpperCase() + source.slice(1);
}
