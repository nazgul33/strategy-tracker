// Request body shared by the sim create (POST) and Apply (PUT) endpoints.
import type { SimUpdateInput } from './api.types';

/** Body shared by POST (create) and PUT (Apply): every config field but the ticker. */
export function simConfigBody(name: string, input: SimUpdateInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: name.trim(),
    from: input.from,
    to: input.to,
    poolCents: input.poolCents,
    costPpm: input.costPpm,
  };
  if (input.buyGapPpm !== undefined) body.buyGapPpm = input.buyGapPpm;
  if (input.sellGapPpm !== undefined) body.sellGapPpm = input.sellGapPpm;
  if (input.cutLossPpm !== undefined) body.cutLossPpm = input.cutLossPpm;
  if (input.params && Object.keys(input.params).length > 0) body.params = input.params;
  return body;
}
