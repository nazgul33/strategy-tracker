import { t, type Lang } from '@st/telegram/i18n'
import type { VrCaptureOutcome } from '../domain/vr/capture'

export function vrCaptureMessage(v: { runId: number; ticker: string; outcome: VrCaptureOutcome }, lang: Lang): string {
  const base = { id: v.runId, ticker: v.ticker }
  if (v.outcome === 'duplicate') return t('vr-capture-duplicate', lang, base)
  const { waiting, dropped, possibleDuplicates } = v.outcome
  if (waiting === 0) return t('vr-capture-none', lang, { ...base, n: dropped })
  const lines = [t('vr-capture-waiting', lang, { ...base, n: waiting })]
  if (dropped > 0) lines.push(t('vr-capture-dropped', lang, { n: dropped }))
  if (possibleDuplicates > 0) lines.push(t('vr-capture-possible-dup', lang, { n: possibleDuplicates }))
  return lines.join('\n')
}
