import type { OrderDto } from '../api';
import { enumLabelKey, orderKindTone, orderStatusTone } from '../viewmodels';
import { priceUsd } from '../format';
import { useT } from '../i18n';
import { Badge, EmptyNote, TableWrap, Td, Th } from './ui';

export function OrderTable({ orders }: { orders: OrderDto[] }) {
  const t = useT();
  if (orders.length === 0) return <EmptyNote>{t('orderEmpty')}</EmptyNote>;
  return (
    <TableWrap>
      <thead>
        <tr>
          <Th>{t('orderColPlaced')}</Th>
          <Th className="text-right">{t('orderColBucket')}</Th>
          <Th>{t('orderColSide')}</Th>
          <Th className="text-right">{t('orderColQty')}</Th>
          <Th className="text-right">{t('orderColPrice')}</Th>
          <Th>{t('orderColStatus')}</Th>
          <Th>{t('orderColReason')}</Th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id}>
            <Td className="whitespace-nowrap tabular-nums">{o.tradeDate}</Td>
            <Td className="text-right tabular-nums">{o.bucketIdx + 1}</Td>
            <Td>
              <Badge tone={orderKindTone(o.kind)}>{t(enumLabelKey('orderKind', o.kind))}</Badge>
            </Td>
            <Td className="text-right tabular-nums">{o.shares}</Td>
            <Td className="text-right tabular-nums">{priceUsd(o.limitPrice)}</Td>
            <Td>
              <Badge tone={orderStatusTone(o.status)}>{t(enumLabelKey('orderStatus', o.status))}</Badge>
            </Td>
            <Td className="text-muted-foreground">
              {o.skipReason ? t(enumLabelKey('orderReason', o.skipReason)) : '—'}
            </Td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}
