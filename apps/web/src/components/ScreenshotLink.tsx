import { api } from '../api';
import { useT } from '../i18n';

// A stored screenshot that opens the original in a new tab, so small digits
// can be read at full size. Shared by the Compare dialog and the Vision review tab.
export function ScreenshotLink({ captureId, imgClassName = '' }: { captureId: number; imgClassName?: string }) {
  const t = useT();
  return (
    <a
      href={api.captureImageUrl(captureId)}
      target="_blank"
      rel="noreferrer"
      title={t('screenshotOpenFull')}
      className="block"
    >
      <img
        src={api.captureImageUrl(captureId)}
        alt={t('pendingScreenshotAlt')}
        loading="lazy"
        className={imgClassName}
      />
    </a>
  );
}
