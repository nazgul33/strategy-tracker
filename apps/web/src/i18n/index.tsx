import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { catalogs, lookup } from './catalog';
import type { Lang } from './catalog';

export { catalogs, lookup };
export type { Entry, Lang } from './catalog';

const LangContext = createContext<{ lang: Lang; setLang: (lang: Lang) => void }>({
  lang: 'en',
  setLang: () => undefined,
});

export function useLang(): { lang: Lang; setLang: (lang: Lang) => void } {
  return useContext(LangContext);
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem('st-lang') === 'ko' ? 'ko' : 'en',
  );
  useEffect(() => {
    localStorage.setItem('st-lang', lang);
    document.documentElement.lang = lang;
  }, [lang]);
  const value = useMemo(() => ({ lang, setLang }), [lang]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useT() {
  const { lang } = useLang();
  return useCallback(
    (key: string, params?: Record<string, string | number>) => lookup(lang, key, params),
    [lang],
  );
}

export type Theme = 'light' | 'dark';

const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void }>({
  theme: 'dark',
  setTheme: () => undefined,
});

export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void } {
  return useContext(ThemeContext);
}

/** Toggles the `dark` class on <html>; persisted in localStorage (`st-theme`). */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem('st-theme') === 'light' ? 'light' : 'dark',
  );
  useEffect(() => {
    localStorage.setItem('st-theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);
  const value = useMemo(() => ({ theme, setTheme }), [theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
