// A route id is a canonical positive decimal: no sign, no leading zero, no hex or exponent form.
export function parseId(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) ? id : null
}
