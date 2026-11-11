import { useLang, useTheme } from '../i18n';
import { useT } from '../i18n';

const BTN =
  'rounded border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground';
const ACTIVE = 'border-primary text-foreground';

export function ThemeLangToggle() {
  const t = useT();
  const { theme, setTheme } = useTheme();
  const { lang, setLang } = useLang();
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        aria-label={theme === 'dark' ? t('themeLight') : t('themeDark')}
        className={BTN}
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      >
        {theme === 'dark' ? '☾' : '☀'}
      </button>
      <button
        type="button"
        aria-pressed={lang === 'en'}
        className={`${BTN} ${lang === 'en' ? ACTIVE : ''}`}
        onClick={() => setLang('en')}
      >
        {t('langEn')}
      </button>
      <button
        type="button"
        aria-pressed={lang === 'ko'}
        className={`${BTN} ${lang === 'ko' ? ACTIVE : ''}`}
        onClick={() => setLang('ko')}
      >
        {t('langKo')}
      </button>
    </div>
  );
}
