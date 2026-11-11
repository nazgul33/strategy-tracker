// Password-only sign-in: POST /api/login → token in sessionStorage → #/runs.
import { useState } from 'react';

import { ApiError, api, setToken } from '../api';
import { useT } from '../i18n';
import { Button, Card, ErrorNote, Field, Input } from '../components/ui';

export function LoginPage() {
  const t = useT();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const signIn = async () => {
    if (password === '' || busy) return;
    setBusy(true);
    setFailed(null);
    try {
      const token = await api.login(password);
      setToken(token);
      window.location.hash = '#/runs';
    } catch (err) {
      setFailed(err instanceof ApiError && err.status === 401 ? t('errorUnauthorized') : t('loginFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-4">
      <Card className="space-y-4">
        <div>
          <h1 className="text-lg font-bold">{t('loginTitle')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('loginIntro')}</p>
        </div>
        {failed !== null && <ErrorNote message={failed} />}
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void signIn();
          }}
        >
          <Field label={t('loginPassword')}>
            <Input
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" busy={busy} className="w-full">
            {t('loginSignIn')}
          </Button>
        </form>
      </Card>
    </main>
  );
}
