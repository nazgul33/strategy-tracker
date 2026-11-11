import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAsync } from '../components/hooks';
import { Button, ErrorNote, Field, Input, SectionTitle, Select, Spinner } from '../components/ui';
import { useT } from '../i18n';

export function SettingsPage() {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => api.getSettings(), []);

  const [visionBaseUrl, setVisionBaseUrl] = useState('');
  const [visionModel, setVisionModel] = useState('');
  const [visionApiKey, setVisionApiKey] = useState('');
  const [digestLang, setDigestLang] = useState('en');
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    setVisionBaseUrl(data.visionBaseUrl);
    setVisionModel(data.visionModel);
    setDigestLang(data.digestLang);
  }, [data]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setSaveError(null);
    try {
      await api.saveSettings({
        visionBaseUrl,
        visionModel,
        digestLang,
        ...(visionApiKey ? { visionApiKey } : {}),
      });
      setNotice(t('settingsSaved'));
      setVisionApiKey('');
      reload();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div>
      <SectionTitle>{t('settingsTitle')}</SectionTitle>
      <form onSubmit={onSubmit} className="max-w-lg space-y-4">
        <Field label={t('settingsVisionBaseUrl')}>
          <Input value={visionBaseUrl} onChange={(e) => setVisionBaseUrl(e.target.value)} placeholder="http://host:8000" />
        </Field>
        <Field label={t('settingsVisionModel')}>
          <Input value={visionModel} onChange={(e) => setVisionModel(e.target.value)} placeholder="Qwen3.8-Flash-Next UD-Q3_K_XL(rtx4090)" />
        </Field>
        <Field label={t('settingsVisionApiKey')}>
          <Input type="password" value={visionApiKey} onChange={(e) => setVisionApiKey(e.target.value)} placeholder={data?.hasVisionApiKey ? t('settingsVisionApiKeySet') : ''} autoComplete="off" />
        </Field>
        <Field label={t('settingsDigestLang')}>
          <Select value={digestLang} onChange={(e) => setDigestLang(e.target.value)}>
            <option value="en">{t('langEn')}</option>
            <option value="ko">{t('langKo')}</option>
          </Select>
        </Field>
        {notice && (
          <div className="rounded-lg border border-good/30 bg-good/10 px-4 py-2 text-sm text-good">{notice}</div>
        )}
        {saveError && <ErrorNote message={saveError} />}
        <Button type="submit" variant="primary" busy={busy}>{t('settingsSave')}</Button>
      </form>
    </div>
  );
}
