import { t } from '@st/telegram/i18n';
import type { Lang } from '@st/telegram/i18n';

import type { BadExtractEvent, VisionInUse } from './capture-route';

// The Telegram reply for a failed screenshot read, one line per part. A vision setup failure
// (http) also names the config in use and the setup advice; an unreadable answer names the config.
export function badExtractMessage(event: BadExtractEvent, lang: Lang): string {
  const { detail } = event;
  switch (event.reason) {
    case 'http':
      return [
        t('capture-bad-extract-http', lang, { detail }),
        visionInUse(event.vision, lang),
        t('capture-vision-setup-advice', lang),
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

function visionInUse(vision: VisionInUse, lang: Lang): string {
  return t('capture-vision-in-use', lang, {
    model: vision.model,
    modelSource: t(`vision-source-${vision.modelSource}`, lang),
    baseUrl: vision.baseUrl,
    baseUrlSource: t(`vision-source-${vision.baseUrlSource}`, lang),
    keySource: t(`vision-source-${vision.keySource}`, lang),
  });
}
