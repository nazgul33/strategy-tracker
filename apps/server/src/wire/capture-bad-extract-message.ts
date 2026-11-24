import { t } from '@st/telegram/i18n';
import type { Lang } from '@st/telegram/i18n';

import type { BadExtractEvent, VisionInUse } from './capture-route';

// The Telegram reply for a failed screenshot read, one line per part. The setup-related kinds
// (http, incompatible) read as four lines: the main line, the config in use, the kind's advice
// and the service's original error; an unreadable answer names the config.
export function badExtractMessage(event: BadExtractEvent, lang: Lang): string {
  const { detail } = event;
  switch (event.reason) {
    case 'http':
      return [
        t('capture-bad-extract-http', lang),
        visionInUse(event.vision, lang),
        t('capture-vision-setup-advice', lang),
        originalError(detail, lang),
      ].join('\n');
    case 'incompatible':
      return [
        t('capture-bad-extract-incompatible', lang),
        visionInUse(event.vision, lang),
        t('capture-vision-incompatible-advice', lang),
        originalError(detail, lang),
      ].join('\n');
    case 'unparseable':
      return [t('capture-bad-extract-unparseable', lang, { detail }), visionInUse(event.vision, lang)].join('\n');
    case 'empty':
      return t('capture-bad-extract-empty', lang);
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}

function originalError(detail: string, lang: Lang): string {
  return t('capture-vision-original-error', lang, { detail });
}

function visionInUse(vision: VisionInUse, lang: Lang): string {
  return t('capture-vision-in-use', lang, {
    model: vision.model,
    modelSource: t(`vision-source-${vision.modelSource}`, lang),
    baseUrl: vision.baseUrl,
    baseUrlSource: t(`vision-source-${vision.baseUrlSource}`, lang),
    keySource: t(`vision-source-${vision.keySource}`, lang),
  });
}
