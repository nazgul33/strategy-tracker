import type { ReactNode } from 'react';

import { setToken } from '../api';
import { useT } from '../i18n';
import { ThemeLangToggle } from './ThemeLangToggle';

const NAV = [
  { href: '#/runs', key: 'navRuns', page: 'runs' },
  { href: '#/pending', key: 'navPending', page: 'pending' },
  { href: '#/sim', key: 'navSim', page: 'sim' },
  { href: '#/settings', key: 'navSettings', page: 'settings' },
] as const;

export function Layout({ active, children }: { active: string; children: ReactNode }) {
  const t = useT();
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <a href="#/runs" className="text-base font-bold tracking-tight">
            {t('appName')}
          </a>
          <nav aria-label={t('appName')} className="flex flex-wrap items-center gap-1 text-sm">
            {NAV.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className={`rounded px-2.5 py-1.5 font-medium ${
                  active === item.page
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {t(item.key)}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeLangToggle />
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => {
                setToken(null);
                window.location.hash = '#/login';
              }}
            >
              {t('logout')}
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-6">{children}</main>
      <footer className="mx-auto max-w-6xl px-4 pb-8 text-center text-[11px] text-muted-foreground">
        {t('appName')}
      </footer>
    </div>
  );
}
